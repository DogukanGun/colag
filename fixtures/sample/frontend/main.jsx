import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.jsx';
let token=null;
async function request(route,body){const response=await fetch('/api/'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Request failed');return result}
const api={register:async(email,password)=>request('register',{email,password}),login:async(email,password)=>{const result=await request('login',{email,password});token=result.token;return result},me:()=>request('me'),logout:async()=>{await request('logout',{});token=null}};
createRoot(document.getElementById('root')).render(<App api={api}/>);
