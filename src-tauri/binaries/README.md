# Mihomo Sidecar 二进制目录

请将 mihomo 内核二进制放入本目录，文件名需带平台后缀：

- Windows: `mihomo-x86_64-pc-windows-msvc.exe`
- macOS (Intel): `mihomo-x86_64-apple-darwin`
- macOS (Apple Silicon): `mihomo-aarch64-apple-darwin`
- Linux (x64): `mihomo-x86_64-unknown-linux-gnu`

下载地址：https://github.com/MetaCubeX/mihomo/releases

`tauri.conf.json` 已配置 `externalBin: ["binaries/mihomo"]`，Tauri 会自动根据当前
平台匹配对应后缀的二进制并打包成 sidecar，前端无需关心具体文件名。