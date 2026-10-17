import React, { useState } from 'react';
const card = { maxWidth: 420, margin: '12vh auto', padding: 36, borderRadius: 18, background: '#fff', boxShadow: '0 20px 60px rgba(30,41,90,.12)', fontFamily: 'system-ui, sans-serif' };
const input = { display: 'block', width: '100%', boxSizing: 'border-box', padding: '12px 14px', margin: '6px 0 16px', border: '1px solid #d4d8e2', borderRadius: 10, fontSize: 16 };
const button = { width: '100%', padding: '13px', border: 0, borderRadius: 10, background: '#2563eb', color: '#fff', fontSize: 16, fontWeight: 600, cursor: 'pointer' };
export default function App({ api }) {
  const [mode, setMode] = useState('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [user, setUser] = useState(null);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      if (mode === 'register') await api.register(email, password);
      const result = await api.login(email, password);
      setUser(result.user);
    } catch {
      setError('That did not work. Check your e-mail and password (8 characters or more).');
    }
  }
  if (user)
    return <main style={{ ...card, textAlign: 'center' }}><h1>Welcome, {user.email}!</h1><p>You are signed in.</p>
      <button style={button} onClick={async () => { await api.logout(); setUser(null); setMode('login'); }}>Sign out</button></main>;
  return <main style={card}>
    <h1 style={{ marginTop: 0 }}>{mode === 'register' ? 'Create your account' : 'Welcome back'}</h1>
    <form onSubmit={submit}>
      <label htmlFor="email">E-mail</label><input id="email" style={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor="password">Password</label><input id="password" style={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p role="alert" style={{ color: '#b91c1c' }}>{error}</p>}
      <button style={button} type="submit">{mode === 'register' ? 'Sign up' : 'Sign in'}</button>
    </form>
    <p style={{ textAlign: 'center' }}><a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === 'register' ? 'login' : 'register'); }}>
      {mode === 'register' ? 'I already have an account' : 'Create an account'}</a></p>
  </main>;
}
