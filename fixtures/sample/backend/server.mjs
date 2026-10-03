import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {register,login,authenticate,logout} from './auth.mjs';
export function createAuthServer(){return createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
 try{
  const token=(req.headers.authorization||'').replace(/^Bearer /,'');
  if(req.method==='GET'&&req.url==='/api/me'){const user=authenticate(token);res.statusCode=user?200:401;res.end(JSON.stringify(user?{user}:{error:'Not authenticated'}));return}
  if(req.method==='POST'&&req.url==='/api/logout'){logout(token);res.end(JSON.stringify({ok:true}));return}
  if(req.method!=='POST'||!['/api/register','/api/login'].includes(req.url)){res.statusCode=404;res.end(JSON.stringify({error:'Not found'}));return}
  let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)throw new Error('Request too large')}
  const {email,password}=JSON.parse(body);
  if(req.url==='/api/register'){res.statusCode=201;res.end(JSON.stringify({user:register(email,password)}))}
  else res.end(JSON.stringify(login(email,password)));
 }catch{res.statusCode=400;res.end(JSON.stringify({error:'Invalid credentials or request'}))}
})}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)createAuthServer().listen(4400,'127.0.0.1',()=>console.log('Sample API: http://127.0.0.1:4400'));
