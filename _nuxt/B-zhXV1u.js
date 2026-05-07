const n=(r,e)=>{if(Array.isArray(r)&&(r=r[0]),typeof r!="string")return e;const t=r.replace(/[^a-zA-Z0-9_@#-]/g,"");return t.length>0?t:e};export{n as s};
