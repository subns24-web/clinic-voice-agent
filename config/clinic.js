// Back-compat shim. The knowledge base now lives in config/channels.js (multi-channel).
// `clinic` still points at the dental channel so older imports keep working.
export { clinic, channels, getChannel } from "./channels.js";
