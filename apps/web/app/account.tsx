"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Settings2 } from "lucide-react";
import { api, initials, type User } from "./api";
export function AccountMenu({
  user,
  onSignOut,
}: {
  user: User;
  onSignOut?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<any>(null);
  const [showHealth, setShowHealth] = useState(false);
  const [name, setName] = useState(user.displayName);
  const [saved, setSaved] = useState(user.displayName);
  useEffect(() => {
    setName(user.displayName);
    setSaved(user.displayName);
  }, [user.displayName]);
  async function signOut() {
    await api("/auth/logout", { method: "POST", body: {} });
    onSignOut?.();
    router.push("/");
  }
  return (
    <div className="account">
      <button
        className="avatar human"
        aria-label={`${user.displayName} account`}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!health)
            void api("/health")
              .then(setHealth)
              .catch(() => setHealth({ ready: false, checks: {} }));
        }}
      >
        {initials(saved)}
      </button>
      {open && (
        <div className="account-menu" role="menu">
          <strong>{saved}</strong>
          <span className="micro">{user.email}</span>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const next = await api("/me", {
                method: "PATCH",
                body: { displayName: name },
              });
              setSaved(next.displayName);
              setName(next.displayName);
            }}
          >
            <label>
              Display name
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <button className="secondary small" type="submit">
              Save name
            </button>
          </form>
          <button
            className="menu-row"
            onClick={() => setShowHealth(!showHealth)}
            type="button"
          >
            <Settings2 size={15} /> Service status
          </button>
          {showHealth && health &&
            Object.entries(health.checks || {}).map(([service, check]: any) => (
              <p key={service} className="health-row">
                <span className={`dot ${check.ok ? "online" : ""}`} />
                <b>{service}</b>
                <span>{check.detail}</span>
              </p>
            ))}
          <button className="menu-row" type="button" onClick={() => void signOut()}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
