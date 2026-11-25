// Links that take a person straight to the real thing: the Gmail thread, the Meet call, the calendar event.
export const gmailThreadUrl = (threadId: string, mailbox?: string) =>
  `https://mail.google.com/mail/${mailbox ? `?authuser=${encodeURIComponent(mailbox)}` : "u/0/"}#all/${threadId}`;
