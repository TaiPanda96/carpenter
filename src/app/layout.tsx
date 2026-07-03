import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Carpenter",
  description: "Walking-skeleton template",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-neutral-50 text-black">{children}</body>
    </html>
  );
}
