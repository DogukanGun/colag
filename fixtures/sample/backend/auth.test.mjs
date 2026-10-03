import {test} from 'node:test';
import assert from 'node:assert/strict';
import {register,login,authenticate,logout} from './auth.mjs';
test('register, login, authenticate and logout',()=>{const email=`user-${Date.now()}@example.com`;const user=register(email,'correct-horse-battery');assert.equal(user.email,email);assert.ok(user.id);assert.equal(user.password,undefined);const session=login(email,'correct-horse-battery');assert.ok(session.token);assert.equal(authenticate(session.token).email,email);logout(session.token);assert.equal(authenticate(session.token),null)});
test('reject weak credentials and duplicate registration',()=>{assert.throws(()=>register('invalid','123'));const email='duplicate@example.com';register(email,'strong-password');assert.throws(()=>register(email,'strong-password'));assert.throws(()=>login(email,'incorrect'));assert.throws(()=>login('missing@example.com','password'));assert.equal(authenticate('bogus'),null)});
test('sessions use distinct opaque tokens',()=>{register('sessions@example.com','strong-password');const a=login('sessions@example.com','strong-password'),b=login('sessions@example.com','strong-password');assert.notEqual(a.token,b.token);assert.ok(a.token.length>=32)});

test('HTTP adapter supports register, login, current user and logout',async()=>{
 const {createAuthServer}=await import('./server.mjs');const server=createAuthServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const url=`http://127.0.0.1:${server.address().port}/api`;const email='http@example.com',password='http-strong-password';
 const send=(route,body,token)=>fetch(`${url}/${route}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await send('register',{email,password})).status,201);const session=await(await send('login',{email,password})).json();assert.ok(session.token);assert.equal((await send('me',null,session.token)).status,200);await send('logout',{},session.token);assert.equal((await send('me',null,session.token)).status,401);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
