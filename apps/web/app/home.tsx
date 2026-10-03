"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Blocks, Bot, Layers, Laptop } from "lucide-react";
import { AccountMenu } from "./account";
import { api, type User } from "./api";
export function Home({
  user,
  onSignOut,
}: {
  user: User;
  onSignOut: () => void;
}) {
  const router = useRouter();
  const [rooms, setRooms] = useState<
    { id: string; name: string; role: string; purpose?: string }[]
  >([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    void api("/projects")
      .then(setRooms)
      .catch((e) => setError(e.message));
  }, []);
  async function enter(sheet: "connect" | "agent" | "board") {
    setBusy(sheet);
    setError("");
    try {
      const room = await api("/projects", {
        body: {
          name: sheet === "board" ? "New app" : "New room",
          ...(sheet === "board" ? { purpose: "app" } : {}),
        },
      });
      router.push(`/rooms/${room.id}?sheet=${sheet}`);
    } catch (e: any) {
      setError(e.message);
      setBusy("");
    }
  }
  return (
    <main className="gate home-gate">
      <header className="home-bar">
        <a className="brand" href="/">
          <span className="logo">
            <Layers size={18} />
          </span>
          colag
        </a>
        <AccountMenu user={user} onSignOut={onSignOut} />
      </header>
      <div className="home-choices">
        <h1>How do you want to work?</h1>
        <div className="choice-row">
          <button
            className="choice"
            disabled={!!busy}
            onClick={() => void enter("connect")}
          >
            <Laptop size={22} />
            <strong>Bring your agent</strong>
            <span>Connect Cursor or Claude Code to a shared room.</span>
          </button>
          <button
            className="choice"
            disabled={!!busy}
            onClick={() => void enter("agent")}
          >
            <Bot size={22} />
            <strong>Use a Colag agent</strong>
            <span>Command one hosted agent. You still approve and merge.</span>
          </button>
          <button
            className="choice"
            disabled={!!busy}
            onClick={() => void enter("board")}
          >
            <Blocks size={22} />
            <strong>Make an app together</strong>
            <span>Share one board, then let Atlas explain the app.</span>
          </button>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <section className="room-list">
          <h2>Your rooms</h2>
          {rooms.length ? (
            rooms.map((room) => (
              <a key={room.id} href={`/rooms/${room.id}`}>
                <strong>{room.name}</strong>
                <span>
                  {room.role === "owner" ? "Owner" : "Member"}
                  {room.purpose === "app" ? " · Design board" : ""}
                </span>
              </a>
            ))
          ) : (
            <p>No rooms yet. Pick a way in above.</p>
          )}
        </section>
      </div>
    </main>
  );
}
