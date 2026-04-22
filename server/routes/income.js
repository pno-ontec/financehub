'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, run } = require('../db/database');
const tid = req => req.user.tenantId;

// ── CRUD Income Sources ───────────────────────────────────────────────────────

// GET /api/income/sources
router.get('/sources', async (req, res) => {
  res.json(await query(`
    SELECT is2.*, e.label as entity_label, e.type as entity_type
    FROM income_sources is2
    LEFT JOIN entities e ON e.id=is2.entity_id
    WHERE is2.tenant_id=? ORDER BY is2.created_at DESC
  `, [tid(req)]));
});

// POST /api/income/sources
router.post('/sources', async (req, res) => {
  const t = tid(req);
  const {
    name, type, entity_id,
    // CLT
    gross_salary, inss_deduction, irrf_deduction, other_deductions, net_salary,
    benefit_health, benefit_food, benefit_transport,
    // PJ
    gross_revenue, tax_regime, das_amount, simples_rate, pro_labore, income_tax_pj,
    // Geral
    amount,
  } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name e type obrigatórios' });

  const id = uuidv4();
  await run(`INSERT INTO income_sources 
    (id,tenant_id,entity_id,name,type,amount,
     gross_salary,inss_deduction,irrf_deduction,other_deductions,net_salary,
     benefit_health,benefit_food,benefit_transport,
     gross_revenue,tax_regime,das_amount,simples_rate,pro_labore,income_tax_pj)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id,t,entity_id||null,name,type,
     parseFloat(amount||net_salary||gross_revenue||0),
     parseFloat(gross_salary||0),parseFloat(inss_deduction||0),parseFloat(irrf_deduction||0),
     parseFloat(other_deductions||0),parseFloat(net_salary||0),
     parseFloat(benefit_health||0),parseFloat(benefit_food||0),parseFloat(benefit_transport||0),
     parseFloat(gross_revenue||0),tax_regime||null,parseFloat(das_amount||0),
     parseFloat(simples_rate||0),parseFloat(pro_labore||0),parseFloat(income_tax_pj||0)]);

  res.status(201).json(await queryOne('SELECT * FROM income_sources WHERE id=?', [id]));
});

// PUT /api/income/sources/:id
router.put('/sources/:id', async (req, res) => {
  const t = tid(req);
  const allowed = ['name','type','amount','gross_salary','inss_deduction','irrf_deduction',
    'other_deductions','net_salary','benefit_health','benefit_food','benefit_transport',
    'gross_revenue','tax_regime','das_amount','simples_rate','pro_labore','income_tax_pj','is_active','entity_id'];
  const sets=[],params=[];
  for(const k of allowed) if(req.body[k]!==undefined){sets.push(`${k}=?`);params.push(req.body[k]);}
  if(!sets.length) return res.status(400).json({error:'Nada para atualizar'});
  params.push(req.params.id,t);
  await run(`UPDATE income_sources SET ${sets.join(',')} WHERE id=? AND tenant_id=?`,params);
  res.json(await queryOne('SELECT * FROM income_sources WHERE id=?',[req.params.id]));
});

// DELETE /api/income/sources/:id
router.delete('/sources/:id', async (req, res) => {
  await run('DELETE FROM income_sources WHERE id=? AND tenant_id=?', [req.params.id, tid(req)]);
  res.json({ message: 'Removido' });
});

module.exports = router;
