# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the React + TypeScript UI entry points, with `src/App.tsx` holding most sidebar logic and `src/App.css` defining the Fluent-style interface. Static assets for the web layer live in `public/` and `src/assets/`. The Tauri backend lives in `src-tauri/`: Rust commands are implemented in `src-tauri/src/lib.rs`, the desktop entry point is `src-tauri/src/main.rs`, and packaging/runtime settings are in `src-tauri/tauri.conf.json`. App icons are stored under `src-tauri/icons/`.

## Build, Test, and Development Commands
Use `npm install` once to install frontend and Tauri CLI dependencies. Use `npm run dev` to start the Vite frontend only. Use `npm run tauri dev` to run the desktop app with the Rust backend and frontend together. Use `npm run build` to type-check with `tsc` and build the production frontend bundle. For Rust-only verification, run `cargo check --manifest-path src-tauri/Cargo.toml`.

## Coding Style & Naming Conventions
Follow the existing style: TypeScript uses 2-space indentation, double quotes, and strict compiler settings from `tsconfig.json`. Name React components in PascalCase, hooks/state helpers in camelCase, and keep UI event handlers descriptive, for example `handleToolClick`. Rust follows standard `rustfmt` conventions with `snake_case` functions and clear `#[tauri::command]` names such as `toggle_taskbar`. Prefer small, focused functions over adding more logic to already large UI components.

## Testing Guidelines
There is no dedicated automated test suite yet. Before opening a PR, at minimum run `npm run build` and `cargo check --manifest-path src-tauri/Cargo.toml`. For UI or system-integration changes, manually verify the affected desktop behavior in `npm run tauri dev`, especially Windows-specific actions, tray behavior, shortcuts, and sidebar visibility transitions.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit style, often with scoped subjects such as `feat(clipboard): ...` or `feat(番茄钟): ...`. Keep the type prefix (`feat`, `fix`, `refactor`, `docs`) and use a short scope when helpful. Pull requests should include a brief summary, the commands you ran to verify the change, and screenshots or short recordings for UI updates. Call out any Windows-only behavior or manual test requirements explicitly.

## Platform Notes
This repository is desktop-focused and currently contains Windows-specific backend behavior in `src-tauri/src/lib.rs`. Keep new system integrations behind platform checks when they are not cross-platform.
