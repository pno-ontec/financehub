'use strict';

const { run, query, queryOne, transaction } = require('../db/database');
const { v4: uuidv4 } = require('uuid');

/**
 * Gera tabela Price (parcelas iguais com juros compostos)
 */
function generatePriceTable(principal, monthlyRate, n) {
  if (monthlyRate === 0) {
    const installment = principal / n;
    return Array.from({ length: n }, (_, i) => ({
      number:    i + 1,
      amount:    parseFloat(installment.toFixed(2)),
      principal: parseFloat(installment.toFixed(2)),
      interest:  0,
    }));
  }
  const r = monthlyRate / 100;
  const pmt = principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  let balance = principal;
  return Array.from({ length: n }, (_, i) => {
    const interest   = parseFloat((balance * r).toFixed(2));
    const principalP = parseFloat((pmt - interest).toFixed(2));
    balance -= principalP;
    return { number: i + 1, amount: parseFloat(pmt.toFixed(2)), principal: principalP, interest };
  });
}

/**
 * Cria contrato de parcelamento/financiamento e gera todas as parcelas
 */
function createContract(tenantId, data) {
  return transaction(() => {
    const {
      description, type, account_id, entity_id, category_id,
      total_amount, down_payment = 0, interest_rate = 0,
      total_installments, first_due_date, notes,
    } = data;

    const financed = total_amount - down_payment;
    const table    = generatePriceTable(financed, interest_rate, total_installments);
    const installmentAmount = table[0].amount;

    // Calcular data de fim
    const startDate = new Date(first_due_date);
    const endDate   = new Date(first_due_date);
    endDate.setMonth(endDate.getMonth() + total_installments - 1);

    const dayOfMonth = startDate.getDate();
    const contractId = uuidv4();

    run(
      `INSERT INTO installment_contracts
         (id, tenant_id, account_id, entity_id, category_id,
          description, type, total_amount, financed_amount, down_payment,
          interest_rate, total_installments, paid_installments,
          installment_amount, start_date, end_date, first_due_date,
          day_of_month, status, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,  'active',?)`,
      [contractId, tenantId, account_id||null, entity_id||null, category_id||null,
       description, type||'installment', total_amount, financed, down_payment,
       interest_rate, total_installments, installmentAmount,
       startDate.toISOString().slice(0,10), endDate.toISOString().slice(0,10),
       first_due_date, dayOfMonth, notes||null]
    );

    // Gerar parcelas
    const today = new Date().toISOString().slice(0,10);
    for (const row of table) {
      const dueDate = new Date(first_due_date);
      dueDate.setMonth(dueDate.getMonth() + row.number - 1);
      const dueDateStr = dueDate.toISOString().slice(0,10);
      const status = dueDateStr < today ? 'overdue' : 'pending';
      run(
        `INSERT INTO installments
           (id, contract_id, tenant_id, number, amount, principal, interest, due_date, status)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [uuidv4(), contractId, tenantId, row.number,
         row.amount, row.principal, row.interest, dueDateStr, status]
      );
    }

    // Registrar entrada (down_payment como transação se > 0)
    if (down_payment > 0 && account_id) {
      run(
        `INSERT INTO transactions
           (id, tenant_id, account_id, entity_id, category_id,
            description, amount, flow, status, date, source, is_recurring)
         VALUES (?,?,?,?,?,?,?,'out','paid',?,  'manual',0)`,
        [uuidv4(), tenantId, account_id, entity_id||null, category_id||null,
         `Entrada — ${description}`, down_payment,
         first_due_date]
      );
    }

    return getContract(contractId, tenantId);
  });
}

function getContract(contractId, tenantId) {
  const contract = queryOne(
    `SELECT c.*,
       a.name as account_name, a.bank as account_bank,
       e.label as entity_label,
       cat.name as category_name, cat.icon as category_icon, cat.color as category_color
     FROM installment_contracts c
     LEFT JOIN accounts    a   ON a.id = c.account_id
     LEFT JOIN entities    e   ON e.id = c.entity_id
     LEFT JOIN categories  cat ON cat.id = c.category_id
     WHERE c.id=? AND c.tenant_id=?`,
    [contractId, tenantId]
  );
  if (!contract) return null;

  contract.installments = query(
    `SELECT * FROM installments WHERE contract_id=? ORDER BY number`,
    [contractId]
  );
  return contract;
}

function listContracts(tenantId, filters = {}) {
  let sql = `
    SELECT c.*,
      a.name as account_name, a.bank as account_bank,
      e.label as entity_label,
      cat.name as category_name, cat.icon as category_icon, cat.color as category_color,
      (SELECT COUNT(*) FROM installments i WHERE i.contract_id=c.id AND i.status='paid') as paid_count,
      (SELECT COUNT(*) FROM installments i WHERE i.contract_id=c.id AND i.status='overdue') as overdue_count
    FROM installment_contracts c
    LEFT JOIN accounts    a   ON a.id = c.account_id
    LEFT JOIN entities    e   ON e.id = c.entity_id
    LEFT JOIN categories  cat ON cat.id = c.category_id
    WHERE c.tenant_id=?`;
  const params = [tenantId];
  if (filters.status) { sql += ` AND c.status=?`; params.push(filters.status); }
  if (filters.entity_id) { sql += ` AND c.entity_id=?`; params.push(filters.entity_id); }
  sql += ` ORDER BY c.created_at DESC`;
  return query(sql, params);
}

/**
 * Marcar parcela como paga e criar transação correspondente
 */
function payInstallment(installmentId, tenantId, paidDate) {
  return transaction(() => {
    const inst = queryOne(
      `SELECT i.*, c.description, c.account_id, c.entity_id, c.category_id, c.type
       FROM installments i
       JOIN installment_contracts c ON c.id = i.contract_id
       WHERE i.id=? AND i.tenant_id=?`,
      [installmentId, tenantId]
    );
    if (!inst) throw new Error('Parcela não encontrada');
    if (inst.status === 'paid') throw new Error('Parcela já foi paga');

    const txId = uuidv4();
    const date = paidDate || new Date().toISOString().slice(0,10);

    // Cria transação
    run(
      `INSERT INTO transactions
         (id, tenant_id, account_id, entity_id, category_id,
          description, amount, flow, status, date, source,
          is_recurring, installment_id)
       VALUES (?,?,?,?,?,?,?,'out','paid',?,'manual',0,?)`,
      [txId, tenantId, inst.account_id, inst.entity_id, inst.category_id,
       `${inst.description} — Parcela ${inst.number}`,
       inst.amount, date, installmentId]
    );

    // Atualiza parcela
    run(`UPDATE installments SET status='paid', paid_date=?, transaction_id=? WHERE id=?`,
      [date, txId, installmentId]);

    // Atualiza contador no contrato
    run(`UPDATE installment_contracts SET paid_installments = paid_installments + 1 WHERE id=?`,
      [inst.contract_id]);

    // Verifica se quitou
    const contract = queryOne(
      `SELECT total_installments, paid_installments FROM installment_contracts WHERE id=?`,
      [inst.contract_id]
    );
    if (contract.paid_installments >= contract.total_installments) {
      run(`UPDATE installment_contracts SET status='paid_off' WHERE id=?`, [inst.contract_id]);
    }

    return { ok: true, transaction_id: txId };
  });
}

module.exports = { createContract, getContract, listContracts, payInstallment };
