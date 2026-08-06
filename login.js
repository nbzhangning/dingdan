// 登录页：校验后保存用户信息并跳转至下单页
(function () {
    const API_BASE = (function () {
        const isLocal =
            window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1' ||
            window.location.hostname === '';
        return isLocal ? 'http://localhost:3330' : window.location.origin;
    })();

    const MIN_SUBMIT_INTERVAL_MS = 2000;
    let lastSubmitAt = 0;

    window.handleLogin = function (event) {
        event.preventDefault();
        const now = Date.now();
        if (now - lastSubmitAt < MIN_SUBMIT_INTERVAL_MS) {
            showMsg('请勿频繁点击，稍后再试', 'error');
            return false;
        }
        lastSubmitAt = now;

        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const btn = document.getElementById('loginBtn');
        showMsg('', '');
        btn.disabled = true;
        btn.textContent = '登录中...';

        fetch(API_BASE + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, password: password })
        })
            .then(function (res) {
                return res.json().then(function (data) {
                    return { status: res.status, data: data };
                });
            })
            .then(function (result) {
                const data = result.data;
                if (data.success && data.user) {
                    try {
                        localStorage.setItem('order_user', JSON.stringify(data.user));
                        if (data.apiToken) {
                            localStorage.setItem('order_api_token', String(data.apiToken));
                        } else {
                            localStorage.removeItem('order_api_token');
                        }
                    } catch (e) {}
                    showMsg('登录成功，正在跳转...', 'success');
                    var isAdmin =
                        data.user.isAdmin === true ||
                        String(data.user.username || '')
                            .trim()
                            .toLowerCase() === 'admin';
                    window.location.href = isAdmin ? 'admin.html' : 'index.html';
                    return;
                }
                let msg = data.message || '登录失败';
                if (result.status === 429 || data.code === 'IP_RATE_LIMIT') {
                    msg = data.message || '登录过于频繁，请稍后再试';
                }
                showMsg(msg, 'error');
                btn.disabled = false;
                btn.textContent = '登 录';
            })
            .catch(function (err) {
                showMsg('网络错误: ' + (err.message || '请检查服务是否启动'), 'error');
                btn.disabled = false;
                btn.textContent = '登 录';
            });
        return false;
    };

    function showMsg(text, type) {
        const msgEl = document.getElementById('loginMsg');
        if (!msgEl) return;
        if (!text) {
            msgEl.style.display = 'none';
            msgEl.textContent = '';
            return;
        }
        msgEl.className = 'login-msg ' + (type === 'success' ? 'success' : 'error');
        msgEl.textContent = text;
        msgEl.style.display = 'block';
    }
})();
