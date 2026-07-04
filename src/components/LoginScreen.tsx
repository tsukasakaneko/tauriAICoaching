import { useState } from "react";
import type { User } from "../types";
import { api } from "../api";

interface Props {
  onAuthSuccess: (token: string, user: User) => void;
}

export default function LoginScreen({ onAuthSuccess }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const fn = mode === "login" ? api.login : api.register;
      const { token, user } = await fn(email, password);
      onAuthSuccess(token, user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="screen login-screen">
      <div className="login-brand">
        <span className="brand-accent">CoachMate</span> for VALORANT
      </div>
      <h2>{mode === "login" ? "ログイン" : "新規登録"}</h2>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label>メールアドレス</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="example@email.com"
          />
        </div>
        <div className="field">
          <label>パスワード</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            placeholder="8文字以上"
          />
        </div>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={submitting} className="primary-btn">
          {submitting ? "処理中..." : mode === "login" ? "ログイン" : "登録する"}
        </button>
      </form>
      <button
        className="link-btn"
        onClick={() => {
          setMode(mode === "login" ? "register" : "login");
          setError("");
        }}
      >
        {mode === "login" ? "アカウントをお持ちでない方はこちら" : "ログインに戻る"}
      </button>
    </div>
  );
}
