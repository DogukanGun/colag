import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
const users = new Map();
const sessions = new Map();
export function register(email, password) {
  if (!/^[^@\s]+@[^@\s]+$/.test(email || "") || (password || "").length < 8) throw new Error("Invalid");
  if (users.has(email)) throw new Error("Taken");
  const salt = randomBytes(16);
  users.set(email, { id: String(users.size + 1), email, salt, hash: scryptSync(password, salt, 32) });
  return { id: users.get(email).id, email };
}
export function login(email, password) {
  const user = users.get(email);
  if (!user || !timingSafeEqual(user.hash, scryptSync(password || "", user.salt, 32))) throw new Error("Invalid");
  const token = randomBytes(24).toString("hex");
  sessions.set(token, user.id);
  return { token, user: { id: user.id, email } };
}
export function authenticate(token) {
  const id = sessions.get(token);
  const user = [...users.values()].find((u) => u.id === id);
  return user ? { id: user.id, email: user.email } : null;
}
export function logout(token) {
  sessions.delete(token);
}
