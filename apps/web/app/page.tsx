"use client";
import { useEffect, useState } from "react";
import { api, type User } from "./api";
import { Home } from "./home";
import { SignIn } from "./sign-in";
export default function Page() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    void api("/me")
      .then(setUser)
      .catch(() => setUser(null));
  }, []);
  if (user === undefined) return <main className="gate">Loading…</main>;
  if (!user) return <SignIn onUser={setUser} />;
  return <Home user={user} onSignOut={() => setUser(null)} />;
}
