# Zeabur 用：litellm 配置烤入镜像（deploy-from-specification 引用本文件）
# 与 deploy/compose/litellm.yaml 的差异：去掉 database_url（usage 事实源是 mnemosyne 侧 usage_logs）
FROM ghcr.io/berriai/litellm:main-latest
COPY deploy/litellm/config.yaml /app/config.yaml
EXPOSE 4000
ENTRYPOINT ["litellm"]
CMD ["--config", "/app/config.yaml", "--host", "0.0.0.0", "--port", "4000"]
