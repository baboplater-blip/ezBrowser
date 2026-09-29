"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTrustedSender = isTrustedSender;
const TRUSTED_PROTOCOLS = ['browser:', 'file:', 'devtools:'];
const TRUSTED_HOSTS = new Set(['localhost']);
function isTrustedSender(e) {
    try {
        const url = e.sender.getURL();
        if (!url)
            return false;
        const u = new URL(url);
        if (TRUSTED_PROTOCOLS.includes(u.protocol))
            return true;
        if (u.protocol === 'http:' && TRUSTED_HOSTS.has(u.hostname))
            return true;
        return false;
    }
    catch {
        return false;
    }
}
