# Disposable authentication exercise
Implement backend/auth.mjs and frontend/App.jsx. Keep backend/auth.test.mjs unchanged. Use only Node built-ins for backend logic. Frontend can demonstrate the contract using an injected API adapter; do not embed secrets. This sample demonstrates protocol collaboration, not production authentication. Document API decisions in the shared workspace. Do not add dependencies. Tests execute offline in a container.

The fixed HTTP adapter is backend/server.mjs. frontend/main.jsx passes an api prop into App; implement App({api}) using its register, login, me and logout functions. To inspect the completed sample manually, install its dependencies, run npm run dev:api and npm run dev:web in separate terminals, then visit http://127.0.0.1:4401.
