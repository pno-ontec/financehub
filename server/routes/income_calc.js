'use strict';
const router = require('express').Router();

function calcINSS(salary) {
  const faixas = [{ate:1412.00,rate:0.075},{ate:2666.68,rate:0.09},{ate:4000.03,rate:0.12},{ate:7786.02,rate:0.14}];
  let inss=0,prev=0;
  for(const f of faixas){if(salary<=prev)break;const base=Math.min(salary,f.ate)-prev;inss+=base*f.rate;prev=f.ate;if(salary<=f.ate)break;}
  return parseFloat(inss.toFixed(2));
}

function calcIRRF(base) {
  const faixas=[{ate:2259.20,rate:0,ded:0},{ate:2826.65,rate:0.075,ded:169.44},{ate:3751.05,rate:0.15,ded:381.44},{ate:4664.68,rate:0.225,ded:662.77},{ate:Infinity,rate:0.275,ded:896.00}];
  if(base<=2259.20)return 0;
  for(const f of faixas){if(base<=f.ate)return parseFloat(Math.max(0,base*f.rate-f.ded).toFixed(2));}
  return 0;
}

const MEI_DAS={comercio:71.60,servicos:75.60,industria:72.60};
const SIMPLES_ANEXOS={
  I:[{ate:180000,rate:4.0},{ate:360000,rate:7.3},{ate:720000,rate:9.5},{ate:1800000,rate:10.7}],
  II:[{ate:180000,rate:4.5},{ate:360000,rate:7.8},{ate:720000,rate:10.0},{ate:1800000,rate:11.2}],
  III:[{ate:180000,rate:6.0},{ate:360000,rate:11.2},{ate:720000,rate:13.5},{ate:1800000,rate:16.0}],
  V:[{ate:180000,rate:15.5},{ate:360000,rate:18.0},{ate:720000,rate:19.5},{ate:1800000,rate:20.5}],
};
function calcSimples(annual,anexo='III'){
  const t=SIMPLES_ANEXOS[anexo]||SIMPLES_ANEXOS.III;
  for(const f of t){if(annual<=f.ate)return f.rate;}return 22.0;
}

router.post('/clt',(req,res)=>{
  const{gross_salary,benefit_health=0,benefit_food=0,benefit_transport=0,dependents=0}=req.body;
  if(!gross_salary)return res.status(400).json({error:'gross_salary obrigatório'});
  const salary=parseFloat(gross_salary);
  const inss=calcINSS(salary);
  const dedDep=dependents*189.59;
  const baseIRRF=Math.max(0,salary-inss-dedDep-parseFloat(benefit_health||0));
  const irrf=calcIRRF(baseIRRF);
  const vtDesc=Math.min(parseFloat(benefit_transport||0),salary*0.06);
  const totalDed=inss+irrf+vtDesc;
  res.json({gross_salary:salary,inss,irrf,vt_desconto:vtDesc,deducao_dependentes:dedDep,
    benefit_health:parseFloat(benefit_health||0),benefit_food:parseFloat(benefit_food||0),
    benefit_transport:parseFloat(benefit_transport||0),total_deductions:parseFloat(totalDed.toFixed(2)),
    net_salary:parseFloat((salary-totalDed).toFixed(2)),effective_rate:parseFloat(((totalDed/salary)*100).toFixed(1))});
});

router.post('/mei',(req,res)=>{
  const{revenue,activity='servicos'}=req.body;
  if(!revenue)return res.status(400).json({error:'revenue obrigatório'});
  const rev=parseFloat(revenue),das=MEI_DAS[activity]||75.60;
  res.json({gross_revenue:rev,das_monthly:das,das_annual:das*12,net_revenue:rev-das,limit_annual:81000,limit_remaining:Math.max(0,81000/12-rev)});
});

router.post('/simples',(req,res)=>{
  const{monthly_revenue,annual_revenue,anexo='III',pro_labore=0}=req.body;
  if(!monthly_revenue)return res.status(400).json({error:'monthly_revenue obrigatório'});
  const monthly=parseFloat(monthly_revenue),annual=parseFloat(annual_revenue)||monthly*12;
  const rate=calcSimples(annual,anexo),tax=monthly*(rate/100);
  const pl=parseFloat(pro_labore);
  const inss_pl=pl>0?calcINSS(pl):0,irrf_pl=pl>0?calcIRRF(Math.max(0,pl-inss_pl)):0;
  res.json({monthly_revenue:monthly,annual_revenue:annual,simples_rate:rate,simples_tax:parseFloat(tax.toFixed(2)),
    pro_labore:pl,inss_pro_labore:inss_pl,irrf_pro_labore:irrf_pl,
    total_monthly_tax:parseFloat((tax+inss_pl+irrf_pl).toFixed(2)),
    net_monthly:parseFloat((monthly-tax-inss_pl-irrf_pl).toFixed(2)),anexo});
});

module.exports = router;
