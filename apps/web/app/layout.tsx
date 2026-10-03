import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Colag — shared engineering workspace",
  description: "Plan, build and review with your agent team.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
