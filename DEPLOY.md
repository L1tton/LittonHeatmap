# 路线总和图：完整部署教程

部署目标：

- 服务器：阿里云 ECS，公网 IP `120.26.170.230`
- 域名：`penfight.fun`
- 系统：Ubuntu 22.04 / 24.04（阿里云 Linux 的差异见文末）
- 运行方式：Node.js + systemd + Nginx + HTTPS

---

## 0. 先看三个关键前提

### 0.1 域名备案

`120.26.170.230` 是中国大陆阿里云 IP。用域名 `penfight.fun` 对公众提供网站前，**通常必须先完成 ICP 备案**，否则 80/443 访问可能被拦截。

请先在阿里云“ICP 代备案管理系统”确认：

- `penfight.fun` 这个后缀是否可以备案
- 域名实名认证是否完成
- 备案主体和服务器是否匹配

如果 `.fun` 不能备案，或者你不想备案，只能考虑：

- 换一个可备案的域名
- 换香港/境外服务器
- 仅用 IP + 端口临时测试（不推荐长期公开，Cookie 同步也不应该走 HTTP）

**没有备案就不要指望域名能稳定打开。** 下面的 Nginx/HTTPS 步骤可以配置，但备案完成前访问仍可能被拦截。

### 0.2 不要复制本机的天地图 key

本机 `.env` 里的 key 绑定的是本机公网 IP `39.191.31.96`，复制到服务器会 403。

要在天地图控制台**新建一个服务端 key**，把服务器出口 IP `120.26.170.230` 加入白名单。如果服务器通过 NAT 网关出网，填 NAT 的 EIP，不是内网 IP。

### 0.3 不要暴露 5173

Node 只监听 `127.0.0.1:5173`，由 Nginx 对外提供 80/443。不要把 5173 开到公网。

---

## 1. 准备 DNS

> 当前实测：`penfight.fun` 已解析到 `120.26.170.230`。如果以后换 IP 或换 DNS 服务商，再按下面重新配置。

在域名 DNS 控制台添加：

| 主机记录 | 类型 | 记录值 | TTL |
| --- | --- | --- | --- |
| `@` | A | `120.26.170.230` | 600 |

建议先只使用 `penfight.fun`，不要同时加 `www`；否则还要处理跨域 Origin 和证书，容易出问题。

检查解析：

```bash
dig +short penfight.fun
# 或
nslookup penfight.fun 8.8.8.8
```

应返回 `120.26.170.230`。

---

## 2. 阿里云安全组和系统防火墙

> 当前实测：`120.26.170.230` 的 22 端口开放，80/443 暂未开放。部署时需要在安全组和系统防火墙里放行 80/443。

### 2.1 安全组入方向

| 端口 | 来源 | 用途 |
| --- | --- | --- |
| 22 | 你的办公/家庭公网 IP | SSH |
| 80 | 0.0.0.0/0 | HTTP，证书验证和跳转 |
| 443 | 0.0.0.0/0 | HTTPS |

不要放行 5173。

### 2.2 系统防火墙

如果启用了 ufw：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

阿里云安全组和系统防火墙是两层，都要放行。

---

## 3. 登录服务器并创建部署用户

```bash
ssh root@120.26.170.230
```

创建 `deploy` 用户：

```bash
adduser deploy
usermod -aG sudo deploy
```

把 root 的 SSH 公钥复制给 deploy（如果你用密钥登录）：

```bash
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy/
```

测试新用户：

```bash
ssh deploy@120.26.170.230
sudo whoami
```

后续命令默认用 `deploy` 用户执行，需要时加 `sudo`。

---

## 4. 安装 Node.js、Nginx、Git

Ubuntu：

```bash
sudo apt update
sudo apt install -y curl git nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

要求 Node.js **>= 20.3**，推荐 22 LTS。

这个项目运行时**没有 npm 依赖**，FIT 解析器已经打包在 `web/assets/vendor/`，所以服务器上不需要 `npm install` 也能启动。

---

## 5. 上传项目

### 5.1 在本地 Windows 打包

在项目根目录执行（PowerShell）：

```powershell
cd D:\program\deepseek\dsh\xingzhe-heatmap

tar -czf route-atlas.tar.gz `
  --exclude=.cache `
  --exclude=preview `
  --exclude=node_modules `
  --exclude=.git `
  --exclude=.env `
  .
```

说明：

- `.env` 不能上传，服务器要单独创建
- `preview/` 里有轨迹截图，公开部署不建议带
- `.cache/` 是本机缓存
- `node_modules/` 运行时不需要
- 如果想公开 L1tton 示例，保留 `web/data/`；不想公开就排除 `web/data`

上传：

```powershell
scp route-atlas.tar.gz deploy@120.26.170.230:/tmp/
```

### 5.2 在服务器解压

```bash
sudo mkdir -p /opt/route-atlas
sudo chown deploy:deploy /opt/route-atlas
tar -xzf /tmp/route-atlas.tar.gz -C /opt/route-atlas
ls -la /opt/route-atlas
```

如果不想公开示例数据：

```bash
rm -f /opt/route-atlas/web/data/manifest.json
rm -f /opt/route-atlas/web/data/tracks-*.json
```

首页的示例入口会因为 manifest 404 自动隐藏。

---

## 6. 配置 .env

```bash
cd /opt/route-atlas
cp .env.example .env
chmod 600 .env
nano .env
```

填入：

```ini
HOST=127.0.0.1
PORT=5173
NODE_ENV=production
TRUST_PROXY=1
ALLOWED_ORIGIN=https://penfight.fun
TIANDITU_KEY=你的天地图服务端key
```

可选：

```ini
MAX_SYNC_TRACKS=1500
GLOBAL_SYNC_LIMIT=3
```

注意：

- `TIANDITU_KEY` 必须是**服务端 key**，IP 白名单里是 `120.26.170.230`
- 不要用浏览器端 key
- `.env` 权限保持 600
- 不要提交到 Git

---

## 7. 先手动启动测试

```bash
cd /opt/route-atlas
node serve.mjs
```

另开一个 SSH 会话：

```bash
curl http://127.0.0.1:5173/api/health
# {"ok":true,"tianditu":true}

curl http://127.0.0.1:5173/api/config
# {"tianditu":true}

curl -I http://127.0.0.1:5173/api/tdt/vec_w/4/6/12
# 200 image/png
```

如果 `/api/config` 是 `true` 但瓦片 502：

- 天地图 key 类型不对
- 白名单没加 `120.26.170.230`
- key 配额用完

确认无误后按 `Ctrl+C` 停止，交给 systemd。

---

## 8. systemd 托管

创建服务文件：

```bash
sudo nano /etc/systemd/system/route-atlas.service
```

写入：

```ini
[Unit]
Description=Route Atlas
After=network.target

[Service]
Type=simple
User=deploy
Group=deploy
WorkingDirectory=/opt/route-atlas
EnvironmentFile=/opt/route-atlas/.env
ExecStart=/usr/bin/node /opt/route-atlas/serve.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now route-atlas
sudo systemctl status route-atlas --no-pager
```

看日志：

```bash
journalctl -u route-atlas -f
```

---

## 9. Nginx 反向代理

创建配置：

```bash
sudo nano /etc/nginx/sites-available/route-atlas
```

写入：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name penfight.fun;

    client_max_body_size 2m;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    location /api/sync {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;

        # 行者同步是流式 NDJSON，不能缓冲
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_read_timeout 120s;
    }
}
```

启用：

```bash
sudo ln -s /etc/nginx/sites-available/route-atlas /etc/nginx/sites-enabled/route-atlas
sudo nginx -t
sudo systemctl reload nginx
```

本机验证：

```bash
curl -I -H "Host: penfight.fun" http://127.0.0.1/
curl http://127.0.0.1/api/health -H "Host: penfight.fun"
```

如果出现 403 或“来源校验失败”：

- 确认 `.env` 里 `TRUST_PROXY=1`
- 确认 `ALLOWED_ORIGIN=https://penfight.fun`
- 确认 Nginx 转发了 `Host` 和 `X-Forwarded-Proto`

---

## 10. HTTPS（Let's Encrypt）

域名解析生效、80 端口可访问后：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d penfight.fun --redirect
```

按提示填邮箱、同意条款。Certbot 会自动修改 Nginx 配置并加上 443。

检查自动续期：

```bash
sudo systemctl status certbot.timer --no-pager
sudo certbot renew --dry-run
```

如果你使用阿里云 SSL 证书，也可以在 Nginx 里手动配置 `ssl_certificate` 和 `ssl_certificate_key`，效果相同。

---

## 11. ICP 备案和页脚

如果还没备案：

1. 登录阿里云 → ICP 代备案管理系统
2. 用这台 ECS 和 `penfight.fun` 提交备案
3. 按提示完成管局审核
4. 备案通过后，把备案号放到页面页脚

页脚示例（放在 `web/index.html` 的 footer 或面板底部）：

```html
<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">
  浙ICP备XXXXXXXX号
</a>
```

部分省份还要求公安联网备案，按属地要求办理。

---

## 12. 上线验证

外部访问：

```bash
curl -I https://penfight.fun/
curl https://penfight.fun/api/health
curl https://penfight.fun/api/config
```

浏览器检查：

1. 打开 `https://penfight.fun/`
2. 默认应该是深色底图
3. 切换浅色 / 深色 / 卫星 / 地形
4. 试试路网密度、透明度滑杆
5. 导入一个 GPX / FIT
6. 导出 PNG
7. 如果要同步行者，确认是 HTTPS，再粘贴 Cookie

服务端检查：

```bash
sudo systemctl status route-atlas --no-pager
sudo journalctl -u route-atlas -n 100 --no-pager
sudo tail -n 100 /var/log/nginx/error.log
```

---

## 13. 更新部署

本地改完、测试通过后，重新打包上传：

```powershell
tar -czf route-atlas.tar.gz `
  --exclude=.cache --exclude=preview --exclude=node_modules `
  --exclude=.git --exclude=.env .
scp route-atlas.tar.gz deploy@120.26.170.230:/tmp/
```

服务器先备份：

```bash
sudo tar -czf /root/route-atlas-backup-$(date +%F).tar.gz -C /opt route-atlas
```

再解压覆盖：

```bash
sudo tar -xzf /tmp/route-atlas.tar.gz -C /opt/route-atlas
sudo chown -R deploy:deploy /opt/route-atlas
sudo systemctl restart route-atlas
sudo systemctl status route-atlas --no-pager
```

如果只改了前端文件，也可以只上传对应文件后重启。

---

## 14. 安全加固

```bash
# SSH 密钥登录后，关闭密码登录
sudo nano /etc/ssh/sshd_config
# PasswordAuthentication no
# PermitRootLogin prohibit-password
sudo systemctl reload ssh

# 可选：fail2ban
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
```

另外：

- 阿里云安全组 22 只允许自己的 IP
- 不开放 5173
- `.env` 权限 600
- 不在前端写天地图 key
- 生产环境保持 `NODE_ENV=production`，强制 HTTPS
- 定期更新系统

---

## 15. 常见问题

### 502 Bad Gateway

```bash
sudo systemctl status route-atlas --no-pager
ss -lntp | grep 5173
journalctl -u route-atlas -n 100 --no-pager
```

Node 没起来、端口不对、`.env` 权限/语法错误都会导致 502。

### 403 来源校验失败

检查：

- `ALLOWED_ORIGIN=https://penfight.fun`
- `TRUST_PROXY=1`
- Nginx 是否转发 `Host`、`X-Forwarded-Proto`、`X-Forwarded-Host`

### 天地图瓦片 502 / 403

```bash
curl http://127.0.0.1:5173/api/config
curl -I http://127.0.0.1:5173/api/tdt/vec_w/4/6/12
```

如果 config 是 true 但瓦片失败：

- 是不是服务端 key
- IP 白名单是不是 `120.26.170.230`
- 服务器是否走 NAT 网关（要填 NAT EIP）
- 配额是否用完

### 域名打不开 / 被阻断

- DNS 是否解析到 `120.26.170.230`
- 安全组 80/443 是否放行
- 是否完成 ICP 备案
- `.fun` 是否在可备案后缀名单内

### 行者同步中途断开

- Nginx 的 `/api/sync` 是否关闭了 `proxy_buffering`
- `proxy_read_timeout` 是否足够大
- 是否使用 HTTPS
- 是否触发了行者限流（等待 15–30 分钟）

### 换域名后数据没了

浏览器 IndexedDB 和 localStorage 按 Origin 隔离。换域名等于换站点，旧数据不会自动迁移；换域名前先导出图片，或在旧域名下保留数据。

---

## 16. 可选：Docker 部署

项目自带 Dockerfile。服务器安装 Docker 后：

```bash
cd /opt/route-atlas
sudo docker build -t route-atlas .
sudo docker run -d --name route-atlas --restart unless-stopped \
  -e HOST=0.0.0.0 \
  -e PORT=5173 \
  -e NODE_ENV=production \
  -e TRUST_PROXY=1 \
  -e ALLOWED_ORIGIN=https://penfight.fun \
  -e TIANDITU_KEY="你的服务端key" \
  -p 127.0.0.1:5173:5173 \
  route-atlas
```

容器内必须用 `HOST=0.0.0.0`，否则 Nginx 访问不到。Nginx 配置和前面一样，仍然代理 `127.0.0.1:5173`。

---

## 17. 最小上线清单

- [ ] DNS `penfight.fun -> 120.26.170.230`
- [ ] 安全组放行 22 / 80 / 443
- [ ] 服务器安装 Node >= 20.3
- [ ] 项目解压到 `/opt/route-atlas`
- [ ] `.env` 配置完成，权限 600
- [ ] 天地图服务端 key 白名单是 `120.26.170.230`
- [ ] `route-atlas.service` 正常运行
- [ ] Nginx 反向代理正常
- [ ] `/api/health` 和 `/api/config` 正常
- [ ] HTTPS 证书正常
- [ ] ICP 备案完成，页脚有备案号
- [ ] 浏览器测试导入、切换底图、导出、同步

---

## 18. 如果系统是 Alibaba Cloud Linux / CentOS

前面的目录和配置基本一致，只需替换包管理命令：

```bash
sudo dnf install -y nginx git
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
node -v
sudo systemctl enable --now nginx
```

Nginx 站点配置放到：

```text
/etc/nginx/conf.d/route-atlas.conf
```

内容与第 9 节相同。检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

防火墙用 firewalld：

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

Certbot：

```bash
sudo dnf install -y certbot python3-certbot-nginx
sudo certbot --nginx -d penfight.fun --redirect
```

服务管理、`.env`、systemd、Node 启动方式都不变。
