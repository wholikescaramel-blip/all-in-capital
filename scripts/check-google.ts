import { loadDB } from "../src/lib/store";
import { googleProviders } from "../src/lib/providers";
import { freeSlots, INVITE_RULE, slotLabel } from "../src/lib/slots";

// Read-only check of the Google connection: reads the calendar, sends nothing. npm run check:google
const db = await loadDB();
const p = googleProviders(db);
console.log(`Connected as ${p.mail.mailbox} (since ${db.google?.connected_at}).`);
const slots = await freeSlots(p.calendar, new Date(), INVITE_RULE, 2);
console.log("Calendar read OK. Next two free invite times:", slots.map(slotLabel).join(" | "));
