"use client";
import { useState, type FormEvent } from "react";
import { Layers } from "lucide-react";
import { api, ApiError, type User } from "./api";
export function SignIn({ onUser }: { onUser: (user: User) => void }) {
  const [step, setStep] = useState<"email" | "code" | "name">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [devCode, setDevCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function request(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api("/auth/request", { body: { email } });
      setDevCode(result.code || "");
      setStep("code");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function verify(e: FormEvent, displayName?: string) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api("/auth/verify", {
        body: { email, code, displayName },
      });
      onUser(result.user);
    } catch (err: any) {
      if (err instanceof ApiError && err.code === "name_required") setStep("name");
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="gate">
      <form
        className="gate-card"
        onSubmit={
          step === "email"
            ? request
            : step === "code"
              ? (e) => void verify(e)
              : (e) => void verify(e, name)
        }
      >
        <span className="logo">
          <Layers size={18} />
        </span>
        <h1>Sign in to Colag</h1>
        <p>
          {step === "email" &&
            "Use your email. We’ll send a one-time code, then you can open a room."}
          {step === "code" && `Enter the code sent to ${email}.`}
          {step === "name" && "What should people in the room call you?"}
        </p>
        {step === "email" && (
          <label>
            Email
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
        )}
        {step === "code" && (
          <label>
            Sign-in code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
        )}
        {step === "name" && (
          <label>
            Your name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        {devCode && step === "code" && (
          <p className="dev-code">Development code: {devCode}</p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy} type="submit">
          {step === "email" ? "Send code" : step === "code" ? "Continue" : "Enter Colag"}
        </button>
        {step !== "email" && (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setStep("email");
              setError("");
              setDevCode("");
            }}
          >
            Use a different email
          </button>
        )}
      </form>
    </main>
  );
}
