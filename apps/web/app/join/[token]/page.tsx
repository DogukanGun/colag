"use client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type User } from "../../api";
import { SignIn } from "../../sign-in";
export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    void api("/me")
      .then(setUser)
      .catch(() => setUser(null));
  }, []);
  useEffect(() => {
    if (!user) return;
    void api("/invites/accept", { body: { token: params.token } })
      .then((result) => router.replace(`/rooms/${result.roomId}`))
      .catch((e) => setError(e.message));
  }, [user, params.token, router]);
  if (user === undefined) return <main className="gate">Loading…</main>;
  if (!user) return <SignIn onUser={setUser} />;
  return (
    <main className="gate">
      <p>{error || "Joining the room…"}</p>
    </main>
  );
}
