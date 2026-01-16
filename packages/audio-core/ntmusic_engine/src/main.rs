use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    ntmusic_engine::run_http_server(None, None).await
}
