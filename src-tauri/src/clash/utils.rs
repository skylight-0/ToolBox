//! Clash 工具函数

/// 检查端口是否被占用
pub fn is_port_in_use(port: u16) -> bool {
    std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_err()
}

/// 查找可用端口
pub fn find_available_port(start_port: u16) -> u16 {
    let mut port = start_port;
    while is_port_in_use(port) {
        port += 1;
    }
    port
}
