import { redirect } from "next/navigation";

// The mail list now lives on the Pipeline page, next to the meetings.
export default function MailPage() { redirect("/dashboard"); }
