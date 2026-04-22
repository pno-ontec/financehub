'use strict';

const fs_e = require('fs'), path_e = require('path');
const envPath = path_e.join(__dirname, '.env');
if (fs_e.existsSync(envPath)) {
  for (const line of fs_e.readFileSync(envPath,'utf8').split('\n')) {
    const t=line.trim(); if(!t||t.startsWith('#')) continue;
    const idx=t.indexOf('='); if(idx===-1) continue;
    const k=t.slice(0,idx).trim(), v=t.slice(idx+1).trim();
    if(!process.env[k]) process.env[k]=v;
  }
  console.log('✅  .env carregado');
} else {
  console.warn('⚠️   .env não encontrado — chaves de DEV');
  process.env.JWT_SECRET  = process.env.JWT_SECRET  || 'dev-jwt-secret-financehub-2026!';
  process.env.SECRET_KEY  = process.env.SECRET_KEY  || 'dev-secret-key-2026!';
  process.env.KEY_SALT    = process.env.KEY_SALT    || 'dev-salt-2026!!';
  process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000';
  process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@financehub.com.br';
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
}

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const compression  = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const fs           = require('fs');

const authRouter          = require('./routes/auth');
const dataRouter          = require('./routes/data');
const uploadRouter        = require('./routes/upload');
const subscriptionRouter  = require('./routes/subscription');
const installmentRouter   = require('./routes/installments');
const adminRouter         = require('./routes/admin');
const incomeRouter        = require('./routes/income');
const incomeCalcRouter    = require('./routes/income_calc');
const membersRouter       = require('./routes/members');
const analysisRouter      = require('./routes/analysis');
const debtRouter          = require('./routes/debt');
const reconciliationRouter= require('./routes/reconciliation');
const billsRouter         = require('./routes/bills');

const { verifyToken }       = require('./middleware/auth');
const { checkSubscription } = require('./middleware/subscription');

const { migrate } = require('./db/database');

// Run DB migrations on startup
migrate().then(() => {
  console.log('✅  Database ready');
}).catch(err => {
  console.error('❌  Database migration failed:', err.message);
  process.exit(1);
});

const app   = express();
const PORT  = process.env.PORT || 3000;
const isDev = process.env.NODE_ENV !== 'production';

app.use(helmet({ contentSecurityPolicy: false, hsts: false }));app.use(cors({
  origin: (origin, cb) => {
    if (!origin || isDev) return cb(null, true);
    const allowed = (process.env.ALLOWED_ORIGINS||'').split(',').map(o=>o.trim());
    if (allowed.includes(origin)) return cb(null, true);
    cb(new Error('CORS bloqueado'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE'],
  allowedHeaders: ['Content-Type','Authorization','X-Tenant-Id'],
}));

app.use(rateLimit({ windowMs:15*60*1000, max:300, standardHeaders:true, legacyHeaders:false }));
const authLimiter = rateLimit({ windowMs:15*60*1000, max:15, skipSuccessfulRequests:true });

app.use(compression());
app.use(express.json({ limit:'5mb' }));
app.use(express.urlencoded({ extended:false, limit:'5mb' }));
app.use(cookieParser());

const DATA_DIR   = path.join(__dirname,'data');
const UPLOAD_DIR = path.join(__dirname,'uploads');
if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR,   {recursive:true});
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, {recursive:true});

app.use((req,_,next)=>{ console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`); next(); });

// Públicas
app.use('/api/auth',         authLimiter, authRouter);
app.use('/api/subscription',             subscriptionRouter);
app.use('/api/income/calc',              incomeCalcRouter);
app.get('/api/health', (_,res) => res.json({ status:'ok', ts:Date.now() }));

// Protegidas
app.use('/api/data',            verifyToken, checkSubscription, dataRouter);
app.use('/api/upload',          verifyToken, checkSubscription, uploadRouter);
app.use('/api/installments',    verifyToken, checkSubscription, installmentRouter);
app.use('/api/income',          verifyToken, checkSubscription, incomeRouter);
app.use('/api/members',         verifyToken, checkSubscription, membersRouter);
app.use('/api/analysis',        verifyToken, checkSubscription, analysisRouter);
app.use('/api/debt',            verifyToken, checkSubscription, debtRouter);
app.use('/api/reconciliation',  verifyToken, checkSubscription, reconciliationRouter);
app.use('/api/bills',           verifyToken, checkSubscription, billsRouter);
app.use('/api/admin',           verifyToken, adminRouter);

const CLIENT_DIR = path.join(__dirname,'..','client','public');
app.use(express.static(CLIENT_DIR, {maxAge: isDev?0:'1d'}));
app.get('*', (_,res) => {
  const ip = path.join(CLIENT_DIR,'index.html');
  if (fs.existsSync(ip)) res.sendFile(ip);
  else res.status(404).json({ error: 'Frontend não encontrado' });
});

app.use((err,_req,res,_next)=>{
  console.error('[ERROR]', err.message);
  res.status(err.status||500).json({ error: err.message||'Erro interno' });
});

const HOST = '0.0.0.0';
app.listen(PORT, HOST, ()=>{
  console.log(`\n✅  FinanceHub v5 em http://localhost:${PORT}`);
  console.log(`   Admin: ${process.env.ADMIN_EMAIL}\n`);
});

module.exports = app;
