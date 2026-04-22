'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, run, transaction } = require('../db/database');
const tid = req => req.user.tenantId;

// Dashboard
router.get('/dashboard', (req, res) => {
  const t = tid(req);
  const summary = queryOne(`SELECT COALESCE(SUM(CASE WHEN flow='in' AND status='paid' THEN amount ELSE 0 END),0) as receitas, COALESCE(SUM(CASE WHEN flow='out' AND status='paid' THEN amount ELSE 0 END),0) as despesas, COALESCE(SUM(CASE WHEN flow='out' AND status IN ('pending','overdue') THEN amount ELSE 0 END),0) as a_pagar FROM transactions WHERE tenant_id=?`, [t]);
  const byCategory = query(`SELECT cat.name, cat.icon, cat.color, SUM(tx.amount) as value FROM transactions tx LEFT JOIN categories cat ON cat.id=tx.category_id WHERE tx.tenant_id=? AND tx.flow='out' AND tx.status='paid' GROUP BY tx.category_id ORDER BY value DESC LIMIT 8`, [t]);
  const byAccount = query(`SELECT a.id,a.name,a.bank,a.type,a.color,a.balance FROM accounts a WHERE a.tenant_id=? AND a.is_active=1 ORDER BY a.name`, [t]);
  const byEntity = query(`SELECT e.id,e.label,e.type,e.color, COALESCE(SUM(CASE WHEN tx.flow='in' THEN tx.amount ELSE 0 END),0) as receitas, COALESCE(SUM(CASE WHEN tx.flow='out' THEN tx.amount ELSE 0 END),0) as despesas FROM entities e LEFT JOIN transactions tx ON tx.entity_id=e.id AND tx.tenant_id=? WHERE e.tenant_id=? GROUP BY e.id`, [t,t]);
  const recurrents = query(`SELECT rc.*,a.name as account_name,e.label as entity_label,cat.name as category_name,cat.icon as category_icon FROM recurring_contracts rc LEFT JOIN accounts a ON a.id=rc.account_id LEFT JOIN entities e ON e.id=rc.entity_id LEFT JOIN categories cat ON cat.id=rc.category_id WHERE rc.tenant_id=? AND rc.status='active' ORDER BY rc.next_due_date LIMIT 10`, [t]);
  const upcomingInstallments = query(`SELECT i.*,c.description,c.type as contract_type,a.name as account_name,e.label as entity_label FROM installments i JOIN installment_contracts c ON c.id=i.contract_id LEFT JOIN accounts a ON a.id=c.account_id LEFT JOIN entities e ON e.id=c.entity_id WHERE i.tenant_id=? AND i.status IN ('pending','overdue') ORDER BY i.due_date LIMIT 10`, [t]);
  const entities = query(`SELECT * FROM entities WHERE tenant_id=? ORDER BY label`, [t]);
  const accounts = query(`SELECT * FROM accounts WHERE tenant_id=? AND is_active=1 ORDER BY name`, [t]);
  const categories = query(`SELECT * FROM categories WHERE tenant_id=? ORDER BY type,name`, [t]);
  const saldo = byAccount.reduce((s,a)=>s+(a.balance||0),0);
  res.json({ summary:{...summary,saldo}, byCategory, byAccount, byEntity, recurrents, upcomingInstallments, entities, accounts, categories });
});

// Transactions
router.get('/transactions', (req, res) => {
  const t = tid(req);
  const { entity, account, status, flow, from, to, search, limit=100, offset=0 } = req.query;
  let sql = `SELECT tx.*,a.name as account_name,a.bank as account_bank,e.label as entity_label,e.color as entity_color,cat.name as category_name,cat.icon as category_icon,cat.color as category_color FROM transactions tx LEFT JOIN accounts a ON a.id=tx.account_id LEFT JOIN entities e ON e.id=tx.entity_id LEFT JOIN categories cat ON cat.id=tx.category_id WHERE tx.tenant_id=?`;
  const params=[t];
  if(entity){sql+=` AND tx.entity_id=?`;params.push(entity);}
  if(account){sql+=` AND tx.account_id=?`;params.push(account);}
  if(status){sql+=` AND tx.status=?`;params.push(status);}
  if(flow){sql+=` AND tx.flow=?`;params.push(flow);}
  if(from){sql+=` AND tx.date>=?`;params.push(from);}
  if(to){sql+=` AND tx.date<=?`;params.push(to);}
  if(search){sql+=` AND tx.description LIKE ?`;params.push(`%${search}%`);}
  sql+=` ORDER BY tx.date DESC, tx.created_at DESC LIMIT ? OFFSET ?`;
  params.push(Number(limit),Number(offset));
  res.json({ total: queryOne(`SELECT COUNT(*) as n FROM transactions WHERE tenant_id=?`,[t]).n, transactions: query(sql,params) });
});

router.post('/transactions', (req, res) => {
  const t = tid(req);
  const { description,amount,flow,date,status,account_id,entity_id,category_id,notes,is_recurring } = req.body;
  if(!description||!amount||!flow||!date) return res.status(400).json({error:'description, amount, flow e date são obrigatórios'});
  if(!['in','out'].includes(flow)) return res.status(400).json({error:'flow deve ser "in" ou "out"'});
  const id=uuidv4();
  run(`INSERT INTO transactions (id,tenant_id,account_id,entity_id,category_id,description,amount,flow,status,date,notes,is_recurring,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'manual')`,
    [id,t,account_id||null,entity_id||null,category_id||null,description,Math.abs(Number(amount)),flow,status||'paid',date,notes||null,is_recurring?1:0]);
  if(account_id&&(status||'paid')==='paid'){
    const delta=flow==='in'?Math.abs(Number(amount)):-Math.abs(Number(amount));
    run(`UPDATE accounts SET balance=balance+? WHERE id=? AND tenant_id=?`,[delta,account_id,t]);
  }
  res.status(201).json(queryOne('SELECT * FROM transactions WHERE id=?',[id]));
});

router.put('/transactions/:id', (req, res) => {
  const t=tid(req);
  const tx=queryOne('SELECT id FROM transactions WHERE id=? AND tenant_id=?',[req.params.id,t]);
  if(!tx) return res.status(404).json({error:'Transação não encontrada'});
  const allowed=['description','amount','flow','status','date','account_id','entity_id','category_id','notes'];
  const sets=[],params=[];
  for(const k of allowed) if(req.body[k]!==undefined){sets.push(`${k}=?`);params.push(req.body[k]);}
  if(!sets.length) return res.status(400).json({error:'Nada para atualizar'});
  sets.push('updated_at=?');params.push(new Date().toISOString(),req.params.id,t);
  run(`UPDATE transactions SET ${sets.join(',')} WHERE id=? AND tenant_id=?`,params);
  res.json(queryOne('SELECT * FROM transactions WHERE id=?',[req.params.id]));
});

router.delete('/transactions/:id', (req, res) => {
  const t=tid(req);
  if(!queryOne('SELECT id FROM transactions WHERE id=? AND tenant_id=?',[req.params.id,t]))
    return res.status(404).json({error:'Não encontrada'});
  run('DELETE FROM transactions WHERE id=? AND tenant_id=?',[req.params.id,t]);
  res.json({message:'Removida'});
});

// Accounts
router.get('/accounts',(req,res)=>res.json(query(`SELECT a.*,e.label as entity_label FROM accounts a LEFT JOIN entities e ON e.id=a.entity_id WHERE a.tenant_id=? ORDER BY a.name`,[tid(req)])));
router.post('/accounts',(req,res)=>{
  const t=tid(req);const{name,bank,type,entity_id,color,balance,credit_limit,closing_day,due_day}=req.body;
  if(!name||!bank)return res.status(400).json({error:'name e bank são obrigatórios'});
  const id=uuidv4();
  run(`INSERT INTO accounts (id,tenant_id,entity_id,name,bank,type,color,balance,credit_limit,closing_day,due_day) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[id,t,entity_id||null,name,bank,type||'checking',color||'#0077ff',balance||0,credit_limit||null,closing_day||null,due_day||null]);
  res.status(201).json(queryOne('SELECT * FROM accounts WHERE id=?',[id]));
});
router.put('/accounts/:id',(req,res)=>{
  const t=tid(req);
  if(!queryOne('SELECT id FROM accounts WHERE id=? AND tenant_id=?',[req.params.id,t])) return res.status(404).json({error:'Conta não encontrada'});
  const allowed=['name','bank','type','color','balance','credit_limit','closing_day','due_day','is_active','entity_id'];
  const sets=[],params=[];
  for(const k of allowed) if(req.body[k]!==undefined){sets.push(`${k}=?`);params.push(req.body[k]);}
  if(!sets.length) return res.status(400).json({error:'Nada para atualizar'});
  params.push(req.params.id,t);
  run(`UPDATE accounts SET ${sets.join(',')} WHERE id=? AND tenant_id=?`,params);
  res.json(queryOne('SELECT * FROM accounts WHERE id=?',[req.params.id]));
});
router.delete('/accounts/:id',(req,res)=>{run('DELETE FROM accounts WHERE id=? AND tenant_id=?',[req.params.id,tid(req)]);res.json({message:'Removida'});});

// Entities
router.get('/entities',(req,res)=>res.json(query('SELECT * FROM entities WHERE tenant_id=? ORDER BY label',[tid(req)])));
router.post('/entities',(req,res)=>{
  const t=tid(req);const{label,type,document,color}=req.body;
  if(!label) return res.status(400).json({error:'label obrigatório'});
  const id=uuidv4();
  run('INSERT INTO entities (id,tenant_id,label,type,document,color) VALUES (?,?,?,?,?,?)',[id,t,label,type||'cpf',document||null,color||'#00e5a0']);
  res.status(201).json(queryOne('SELECT * FROM entities WHERE id=?',[id]));
});
router.put('/entities/:id',(req,res)=>{
  const{label,type,document,color}=req.body;
  run(`UPDATE entities SET label=COALESCE(?,label),type=COALESCE(?,type),document=COALESCE(?,document),color=COALESCE(?,color) WHERE id=? AND tenant_id=?`,[label||null,type||null,document||null,color||null,req.params.id,tid(req)]);
  res.json(queryOne('SELECT * FROM entities WHERE id=?',[req.params.id]));
});
router.delete('/entities/:id',(req,res)=>{run('DELETE FROM entities WHERE id=? AND tenant_id=?',[req.params.id,tid(req)]);res.json({message:'Removida'});});

// Categories
router.get('/categories',(req,res)=>res.json(query('SELECT * FROM categories WHERE tenant_id=? ORDER BY type,name',[tid(req)])));
router.post('/categories',(req,res)=>{
  const t=tid(req);const{name,icon,color,type}=req.body;
  if(!name) return res.status(400).json({error:'name obrigatório'});
  const id=uuidv4();
  run('INSERT INTO categories (id,tenant_id,name,icon,color,type) VALUES (?,?,?,?,?,?)',[id,t,name,icon||'📦',color||'#4a5168',type||'expense']);
  res.status(201).json(queryOne('SELECT * FROM categories WHERE id=?',[id]));
});
router.put('/categories/:id',(req,res)=>{
  const t=tid(req);const{name,icon,color,type}=req.body;
  run(`UPDATE categories SET name=COALESCE(?,name),icon=COALESCE(?,icon),color=COALESCE(?,color),type=COALESCE(?,type) WHERE id=? AND tenant_id=?`,[name||null,icon||null,color||null,type||null,req.params.id,t]);
  res.json(queryOne('SELECT * FROM categories WHERE id=?',[req.params.id]));
});
router.delete('/categories/:id',(req,res)=>{
  run('DELETE FROM categories WHERE id=? AND tenant_id=?',[req.params.id,tid(req)]);
  res.json({message:'Removida'});
});

// Recurring
router.get('/recurring',(req,res)=>{
  const t=tid(req);
  res.json(query(`SELECT rc.*,a.name as account_name,e.label as entity_label,cat.name as category_name,cat.icon as category_icon,cat.color as category_color FROM recurring_contracts rc LEFT JOIN accounts a ON a.id=rc.account_id LEFT JOIN entities e ON e.id=rc.entity_id LEFT JOIN categories cat ON cat.id=rc.category_id WHERE rc.tenant_id=? ORDER BY rc.next_due_date`,[t]));
});
router.post('/recurring',(req,res)=>{
  const t=tid(req);
  const{description,amount,flow,frequency,start_date,day_of_month,account_id,entity_id,category_id,auto_launch,notes,end_date}=req.body;
  if(!description||!amount||!flow||!frequency||!start_date) return res.status(400).json({error:'Campos obrigatórios faltando'});
  const d=new Date(start_date);
  const nextDue=calcNextDue(start_date,frequency,day_of_month||d.getDate());
  const id=uuidv4();
  run(`INSERT INTO recurring_contracts (id,tenant_id,account_id,entity_id,category_id,description,amount,flow,frequency,start_date,end_date,next_due_date,day_of_month,auto_launch,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,t,account_id||null,entity_id||null,category_id||null,description,Math.abs(Number(amount)),flow,frequency,start_date,end_date||null,nextDue,day_of_month||d.getDate(),auto_launch!==false?1:0,notes||null]);
  res.status(201).json(queryOne('SELECT * FROM recurring_contracts WHERE id=?',[id]));
});
router.put('/recurring/:id',(req,res)=>{
  const t=tid(req);const allowed=['description','amount','status','notes','end_date','day_of_month','account_id','entity_id','category_id'];
  const sets=[],params=[];
  for(const k of allowed) if(req.body[k]!==undefined){sets.push(`${k}=?`);params.push(req.body[k]);}
  if(!sets.length) return res.status(400).json({error:'Nada'});
  params.push(req.params.id,t);
  run(`UPDATE recurring_contracts SET ${sets.join(',')} WHERE id=? AND tenant_id=?`,params);
  res.json(queryOne('SELECT * FROM recurring_contracts WHERE id=?',[req.params.id]));
});
router.delete('/recurring/:id',(req,res)=>{run('DELETE FROM recurring_contracts WHERE id=? AND tenant_id=?',[req.params.id,tid(req)]);res.json({message:'Removido'});});

// Members
router.get('/members',(req,res)=>{
  res.json(query(`SELECT tm.*,u.name,u.email,u.last_login FROM tenant_members tm LEFT JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=? ORDER BY tm.created_at`,[tid(req)]));
});
router.post('/members/invite',async(req,res)=>{
  const t=tid(req);const{email,permissions=['view']}=req.body;
  if(!email) return res.status(400).json({error:'email obrigatório'});
  const existing=queryOne('SELECT id FROM users WHERE email=?',[email.toLowerCase()]);
  const memberId=uuidv4();
  if(existing){
    const already=queryOne('SELECT id FROM tenant_members WHERE tenant_id=? AND user_id=?',[t,existing.id]);
    if(already) return res.status(409).json({error:'Usuário já é membro'});
    run(`INSERT INTO tenant_members (id,tenant_id,user_id,invite_email,status,permissions) VALUES (?,?,?,?,'active',?)`,[memberId,t,existing.id,email.toLowerCase(),JSON.stringify(permissions)]);
  } else {
    run(`INSERT INTO tenant_members (id,tenant_id,user_id,invite_email,status,permissions) VALUES (?,?,?   ,?,'pending',?)`,[memberId,t,uuidv4(),email.toLowerCase(),JSON.stringify(permissions)]);
  }
  res.status(201).json({message:'Convite enviado',email});
});
router.delete('/members/:id',(req,res)=>{run('DELETE FROM tenant_members WHERE id=? AND tenant_id=?',[req.params.id,tid(req)]);res.json({message:'Removido'});});

// Notifications
router.get('/notifications',(req,res)=>res.json(query(`SELECT * FROM notifications WHERE tenant_id=? ORDER BY created_at DESC LIMIT 50`,[tid(req)])));
router.put('/notifications/:id/read',(req,res)=>{run('UPDATE notifications SET read_at=? WHERE id=? AND tenant_id=?',[new Date().toISOString(),req.params.id,tid(req)]);res.json({ok:true});});
router.put('/notifications/read-all',(req,res)=>{run('UPDATE notifications SET read_at=? WHERE tenant_id=? AND read_at IS NULL',[new Date().toISOString(),tid(req)]);res.json({ok:true});});

function calcNextDue(startDate,frequency,dayOfMonth){
  const d=new Date(startDate),today=new Date();
  if(d>=today) return d.toISOString().slice(0,10);
  if(frequency==='monthly'){const n=new Date();n.setDate(dayOfMonth||d.getDate());if(n<today)n.setMonth(n.getMonth()+1);return n.toISOString().slice(0,10);}
  if(frequency==='weekly'){const n=new Date(today);n.setDate(n.getDate()+7);return n.toISOString().slice(0,10);}
  if(frequency==='yearly'){const n=new Date(d);while(n<today)n.setFullYear(n.getFullYear()+1);return n.toISOString().slice(0,10);}
  return d.toISOString().slice(0,10);
}

module.exports = router;
