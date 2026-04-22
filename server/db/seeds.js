'use strict';

const { run, queryOne } = require('./database');
const { v4: uuidv4 }    = require('uuid');

const DEFAULT_CATEGORIES = [
  // Despesas
  { name: 'Alimentação',    icon: '🍽️',  color: '#ff6b35', type: 'expense' },
  { name: 'Moradia',        icon: '🏠',  color: '#0077ff', type: 'expense' },
  { name: 'Transporte',     icon: '🚗',  color: '#f7c948', type: 'expense' },
  { name: 'Saúde',          icon: '🏥',  color: '#00e5a0', type: 'expense' },
  { name: 'Educação',       icon: '📚',  color: '#8A05BE', type: 'expense' },
  { name: 'Entretenimento', icon: '🎬',  color: '#ff4d6d', type: 'expense' },
  { name: 'Vestuário',      icon: '👕',  color: '#ff6b35', type: 'expense' },
  { name: 'Utilidades',     icon: '⚡',  color: '#f7c948', type: 'expense' },
  { name: 'Impostos',       icon: '🧾',  color: '#7c8494', type: 'expense' },
  { name: 'Seguros',        icon: '🛡️',  color: '#0077ff', type: 'expense' },
  { name: 'Financiamento',  icon: '🏦',  color: '#ff4d6d', type: 'expense' },
  { name: 'Cartão Crédito', icon: '💳',  color: '#8A05BE', type: 'expense' },
  { name: 'Investimentos',  icon: '📈',  color: '#00e5a0', type: 'expense' },
  { name: 'RH / Salários',  icon: '👥',  color: '#ff6b35', type: 'expense' },
  { name: 'Tecnologia',     icon: '💻',  color: '#0077ff', type: 'expense' },
  { name: 'Compras',        icon: '🛍️',  color: '#f7c948', type: 'expense' },
  { name: 'Outros',         icon: '📦',  color: '#4a5168', type: 'expense' },
  // Receitas
  { name: 'Salário CLT',    icon: '💼',  color: '#00e5a0', type: 'income', income_type:'principal' },
  { name: 'Pró-labore PJ',  icon: '🏢',  color: '#0077ff', type: 'income', income_type:'pj'       },
  { name: 'MEI',            icon: '📦',  color: '#f7c948', type: 'income', income_type:'mei'      },
  { name: 'Freelance',      icon: '🖥️',  color: '#00e5a0', type: 'income', income_type:'esporadica'},
  { name: 'Aluguel Recebido',icon: '🏠', color: '#0077ff', type: 'income', income_type:'esporadica'},
  { name: 'Vendas',         icon: '🛒',  color: '#f7c948', type: 'income', income_type:'avulsa'   },
  { name: 'Investimentos',  icon: '📈',  color: '#00e5a0', type: 'income', income_type:'investimento'},
  { name: 'Bônus / PLR',   icon: '🎯',  color: '#ff6b35', type: 'income', income_type:'esporadica'},
  { name: 'Outras Receitas',icon: '💰',  color: '#4a5168', type: 'income', income_type:'avulsa'   },
];

async function seedCategories(tenantId) {
  for (const cat of DEFAULT_CATEGORIES) {
    await run(
      `INSERT INTO categories (id, tenant_id, name, icon, color, type, income_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), tenantId, cat.name, cat.icon, cat.color, cat.type, cat.income_type||null]
    );
  }
}

module.exports = { seedCategories };
