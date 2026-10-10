import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";

const certDir = path.resolve(__dirname, "certs");

export default defineConfig({
    plugins: [react()],
    server: {
        https: {
            key: fs.readFileSync(path.join(certDir, "localhost.key")),
            cert: fs.readFileSync(path.join(certDir, "localhost.crt")),
        },
        host: "0.0.0.0",
        port: 8080,
    },
});
