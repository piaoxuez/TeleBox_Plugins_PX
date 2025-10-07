# TeleBox Docker 镜像
# 基于Node.js 20.x

FROM node:20-slim

# 安装必要的系统依赖
RUN apt-get update && apt-get install -y \
    curl \
    git \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /app

# 克隆TeleBox项目
RUN git clone https://github.com/TeleBoxDev/TeleBox.git .

# 修复Docker环境下的交互式输入问题
# 将 terminal: false 改为 terminal: true
# 好像没什么卵用
RUN sed -i 's/terminal: false/terminal: true/g' src/utils/loginManager.ts

# 安装npm依赖
RUN npm install

# 打印文件内容
RUN cat src/utils/loginManager.ts

# 全局安装PM2进程管理器（用于第6步）
RUN npm install -g pm2

# 暴露端口（根据TeleBox实际需要调整）
# 好像也没什么卵用
EXPOSE 3000

# 创建数据持久化目录
# 好像也没什么卵用
VOLUME ["/app/data", "/app/session"]

# 默认命令：启动交互式配置（第5步）
# 用户需要先运行这个进行初始化配置
CMD ["npm", "start"]
