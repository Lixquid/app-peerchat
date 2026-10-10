import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";

// The production site is served at https://peerchat.lixquid.com (GitHub Pages
// custom domain), so assets live at the root path and the default base is used.

// PeerJS requires a secure context, so the dev server is served over HTTPS
// with an auto-generated self-signed certificate.
export default defineConfig({
    plugins: [basicSsl()],
    server: {
        port: 8443,
        https: true,
        host: true,
    },
    preview: {
        port: 8443,
        https: true,
        host: true,
    },
});
