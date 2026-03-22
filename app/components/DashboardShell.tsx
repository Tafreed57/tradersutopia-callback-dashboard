"use client";

import { useState, useEffect, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface DashboardShellProps {
  children: (ctx: AuthContext) => ReactNode;
}

export interface AuthContext {
  affiliatePhone: string;
  accessCode: string;
  onLogout: () => void;
  onChangePhone: () => void;
}

export default function DashboardShell({ children }: DashboardShellProps) {
  const pathname = usePathname();

  const [accessCode, setAccessCode] = useState("");
  const [isAuth, setIsAuth] = useState(false);
  const [authError, setAuthError] = useState("");

  const [affiliatePhone, setAffiliatePhone] = useState("");
  const [phoneSet, setPhoneSet] = useState(false);

  useEffect(() => {
    const savedAuth = localStorage.getItem("cb_auth");
    const savedCode = localStorage.getItem("cb_code");
    const savedPhone = localStorage.getItem("cb_phone");
    if (savedAuth === "true" && savedCode) {
      setAccessCode(savedCode);
      setIsAuth(true);
    }
    if (savedPhone) {
      setAffiliatePhone(savedPhone);
      setPhoneSet(true);
    }
  }, []);

  function handleLogin() {
    if (!accessCode.trim()) {
      setAuthError("Enter the access code.");
      return;
    }
    localStorage.setItem("cb_auth", "true");
    localStorage.setItem("cb_code", accessCode.trim());
    setIsAuth(true);
    setAuthError("");
  }

  function handleLogout() {
    localStorage.removeItem("cb_auth");
    localStorage.removeItem("cb_code");
    setIsAuth(false);
    setAccessCode("");
  }

  function handleSetPhone() {
    const cleaned = affiliatePhone.trim();
    if (!cleaned.startsWith("+") || cleaned.length < 8) {
      alert("Phone must be E.164 format, e.g. +14375053539");
      return;
    }
    localStorage.setItem("cb_phone", cleaned);
    setAffiliatePhone(cleaned);
    setPhoneSet(true);
  }

  function handleChangePhone() {
    setPhoneSet(false);
  }

  // Login screen
  if (!isAuth) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-8 w-full max-w-sm shadow-2xl">
          <h1 className="text-xl font-bold text-white mb-1">Traders Utopia</h1>
          <p className="text-slate-400 text-sm mb-6">Enter your access code to continue.</p>
          <input
            type="password"
            value={accessCode}
            onChange={(e) => setAccessCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            placeholder="Access code"
            className="w-full px-4 py-3 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-500 mb-3 focus:outline-none focus:border-blue-500"
          />
          {authError && <p className="text-red-400 text-sm mb-3">{authError}</p>}
          <button
            onClick={handleLogin}
            className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg transition"
          >
            Log In
          </button>
        </div>
      </div>
    );
  }

  // Phone input screen
  if (!phoneSet) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-8 w-full max-w-sm shadow-2xl">
          <h1 className="text-xl font-bold text-white mb-1">Your Phone Number</h1>
          <p className="text-slate-400 text-sm mb-6">
            When you click &quot;Call&quot;, we call YOUR phone first, then bridge to the lead.
          </p>
          <input
            type="tel"
            value={affiliatePhone}
            onChange={(e) => setAffiliatePhone(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSetPhone()}
            placeholder="+14375053539"
            className="w-full px-4 py-3 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-500 mb-2 focus:outline-none focus:border-blue-500"
          />
          <p className="text-slate-500 text-xs mb-4">E.164 format: + country code + number</p>
          <button
            onClick={handleSetPhone}
            className="w-full py-3 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg transition"
          >
            Continue
          </button>
          <button
            onClick={handleLogout}
            className="w-full mt-2 py-2 text-slate-400 hover:text-white text-sm transition"
          >
            Log out
          </button>
        </div>
      </div>
    );
  }

  const navLinks = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/history", label: "Call History" },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {/* Top nav bar */}
      <nav className="bg-slate-900 border-b border-slate-700 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-1">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`px-3 py-1.5 text-sm rounded-lg font-medium transition ${
                pathname === link.href
                  ? "bg-blue-600 text-white"
                  : "text-slate-400 hover:text-white hover:bg-slate-800"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-slate-400 text-xs hidden sm:inline">
            {affiliatePhone}
          </span>
          <button
            onClick={handleChangePhone}
            className="text-blue-400 hover:text-blue-300 text-xs underline"
          >
            change
          </button>
          <button
            onClick={handleLogout}
            className="px-3 py-1.5 text-sm text-slate-400 hover:text-white border border-slate-600 rounded-lg transition"
          >
            Log out
          </button>
        </div>
      </nav>

      {/* Page content */}
      {children({
        affiliatePhone,
        accessCode: localStorage.getItem("cb_code") || "",
        onLogout: handleLogout,
        onChangePhone: handleChangePhone,
      })}
    </div>
  );
}
