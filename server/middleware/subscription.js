'use strict';

const { getStatus } = require('../services/subscription');

/**
 * Middleware que verifica se o tenant tem acesso ativo.
 * Deve ser aplicado APÓS verifyToken.
 */
function checkSubscription(req, res, next) {
  const tenantId = req.user?.tenantId;
  if (!tenantId) return res.status(403).json({ error: 'Tenant não identificado' });

  const status = getStatus(tenantId);

  if (status.allowed) {
    req.subscription = status;
    // Avisa se trial acabando (≤ 3 dias)
    if (status.plan === 'trial' && status.daysLeft <= 3) {
      res.setHeader('X-Trial-Days-Left', status.daysLeft);
    }
    return next();
  }

  return res.status(402).json({
    error:  'Acesso bloqueado',
    reason: status.reason,
    code:   'SUBSCRIPTION_REQUIRED',
    sub:    status.sub,
  });
}

module.exports = { checkSubscription };
