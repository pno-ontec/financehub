'use strict';
const jwt = require('jsonwebtoken');

const JWT_SECRET  = () => { if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET não definido'); return process.env.JWT_SECRET; };
const ACCESS_TTL  = '15m';
const REFRESH_TTL = '7d';

function signAccess(payload)  { return jwt.sign(payload, JWT_SECRET(), { expiresIn:ACCESS_TTL,  algorithm:'HS256', issuer:'financehub', audience:'financehub-client' }); }
function signRefresh(payload) { return jwt.sign(payload, JWT_SECRET(), { expiresIn:REFRESH_TTL, algorithm:'HS256', issuer:'financehub', audience:'financehub-client' }); }
function verifyJWT(token)     { return jwt.verify(token, JWT_SECRET(), { algorithms:['HS256'], issuer:'financehub', audience:'financehub-client' }); }

function verifyToken(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
    if (!token && req.cookies?.fh_access) token = req.cookies.fh_access;
    if (!token) return res.status(401).json({ error: 'Não autenticado' });

    const decoded = verifyJWT(token);
    // Expõe todos os campos do token para os middlewares/rotas
    req.user = {
      id:       decoded.sub,
      email:    decoded.email,
      name:     decoded.name,
      tenantId: decoded.tenantId,
      role:     decoded.role,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expirado', code: 'TOKEN_EXPIRED' });
    return res.status(401).json({ error: 'Token inválido' });
  }
}

module.exports = { verifyToken, signAccess, signRefresh, verifyJWT };
