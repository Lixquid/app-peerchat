# PeerChat

Run with `npm run dev`.

<h1><a href="https://peerchat.lixquid.com">PeerChat</a></h1>

Peer to peer chat with WebRTC and PeerJS.

https://peerchat.lixquid.com

## How to Use

Put another instance's Chat ID (from the top left) into the connection box to
create a chat connection.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/)

### Getting Started

1. Clone the repository
2. Install dependencies: `npm install`
3. Start the development server: `npm run start`
4. Open http://localhost:5173 in your browser

Changes to the source files will be automatically reloaded in the browser.

### Building for Production

1. Remove the `dist` folder:
    - \*nix: `rm -rf dist`
    - Windows: `rmdir /s /q dist`
2. Build the project: `npm run build`
3. The production files will be in the `dist` folder

Production files can be served from any static file server.

> AI Disclaimer: Created with the help of NVIDIA's Nemotron model.
