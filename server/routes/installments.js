'use strict';

const router = require('express').Router();
const { listContracts, createContract, getContract, payInstallment } = require('../services/installments');
const { query, queryOne, run } = require('../db/database');
const tid = req => req.user.tenantId;

// GET /api/installments — lista todos os contratos
router.get('/', async (req, res) => {
  try {
    const contracts = listContracts(tid(req), {
      status:    req.query.status,
      entity_id: req.query.entity_id,
    });
    // Calcula totais resumidos
    const totals = {
      total_financed: contracts.reduce((s,c)=>s+c.financed_amount,0),
      total_remaining: contracts.filter(c=>c.status==='active').reduce((s,c)=>{
        const remaining = c.total_installments - c.paid_installments;
        return s + remaining * c.installment_amount;
      },0),
      active: contracts.filter(c=>c.status==='active').length,
      paid_off: contracts.filter(c=>c.status==='paid_off').length,
    };
    res.json({ totals, contracts });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/installments/:id — detalhe com parcelas
router.get('/:id', async (req, res) => {
  const contract = getContract(req.params.id, tid(req));
  if (!contract) return res.status(404).json({ error: 'Contrato não encontrado' });
  res.json(contract);
});

// POST /api/installments — cria contrato
router.post('/', async (req, res) => {
  try {
    const required = ['description','total_amount','total_installments','first_due_date'];
    for (const f of required) {
      if (!req.body[f]) return res.status(400).json({ error: `${f} é obrigatório` });
    }
    const contract = createContract(tid(req), req.body);
    res.status(201).json(contract);
  } catch(err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/installments/:id — edita metadados do contrato
router.put('/:id', async (req, res) => {
  const t = tid(req);
  const allowed = ['description','status','notes','account_id','entity_id','category_id'];
  const sets=[],params=[];
  for(const k of allowed) if(req.body[k]!==undefined){sets.push(`${k}=?`);params.push(req.body[k]);}
  if(!sets.length) return res.status(400).json({error:'Nada para atualizar'});
  params.push(req.params.id,t);
  const { run: dbRun, queryOne: dbGet } = require('../db/database');
  dbRun(`UPDATE installment_contracts SET ${sets.join(',')} WHERE id=? AND tenant_id=?`,params);
  res.json(getContract(req.params.id,t));
});

// DELETE /api/installments/:id — cancela contrato
router.delete('/:id', async (req, res) => {
  await run(`UPDATE installment_contracts SET status='cancelled' WHERE id=? AND tenant_id=?`,
    [req.params.id, tid(req)]);
  res.json({ message: 'Contrato cancelado' });
});

// POST /api/installments/:id/pay/:installmentId — pagar parcela
router.post('/:id/pay/:installmentId', async (req, res) => {
  try {
    const result = payInstallment(req.params.installmentId, tid(req), req.body.paid_date);
    res.json(result);
  } catch(err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/installments/:id/schedule — tabela de amortização
router.get('/:id/schedule', async (req, res) => {
  const t = tid(req);
  const contract = await queryOne('SELECT * FROM installment_contracts WHERE id=? AND tenant_id=?',
    [req.params.id, t]);
  if (!contract) return res.status(404).json({ error: 'Contrato não encontrado' });

  const installments = await query(
    `SELECT * FROM installments WHERE contract_id=? ORDER BY number`,
    [req.params.id]
  );

  const totalPaid     = installments.filter(i=>i.status==='paid').reduce((s,i)=>s+i.amount,0);
  const totalInterest = installments.reduce((s,i)=>s+(i.interest||0),0);
  const totalPrincipal= installments.reduce((s,i)=>s+(i.principal||0),0);

  res.json({
    contract,
    installments,
    summary: {
      total_amount:    contract.total_amount,
      financed_amount: contract.financed_amount,
      down_payment:    contract.down_payment,
      total_interest:  parseFloat(totalInterest.toFixed(2)),
      total_principal: parseFloat(totalPrincipal.toFixed(2)),
      total_paid:      parseFloat(totalPaid.toFixed(2)),
      total_remaining: parseFloat((contract.financed_amount - totalPaid + contract.down_payment > 0 ? installments.filter(i=>i.status!=='paid').reduce((s,i)=>s+i.amount,0) : 0).toFixed(2)),
      progress_pct:    Math.round((contract.paid_installments / contract.total_installments) * 100),
    }
  });
});

module.exports = router;
