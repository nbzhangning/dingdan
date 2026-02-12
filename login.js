// 登录页：验证后保存用户信息并跳转至主页面
(function () {
    const API_BASE = (function () {
        const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname === '';
        return isLocal ? 'http://localhost:3330' : window.location.origin;
    })();

    window.handleLogin = function (e) {
        e.preventDefault();
        var username = document.getElementById('username').value.trim();
        var password = document.getElementById('password').value;
        var btn = document.getElementById('loginBtn');
        var errEl = document.getElementById('loginError');

        if (!username || !password) {
            errEl.textContent = '请输入用户名和密码';
            errEl.classList.add('show');
            return false;
        }

        errEl.classList.remove('show');
        errEl.textContent = '';
        btn.disabled = true;
        btn.textContent = '登录中...';

        fetch(API_BASE + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, password: password })
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (data.success && data.user) {
                    sessionStorage.setItem('user', JSON.stringify(data.user));
                    window.location.href = 'index.html';
                } else {
                    errEl.textContent = data.message || '登录失败';
                    errEl.classList.add('show');
                    btn.disabled = false;
                    btn.textContent = '登录';
                }
            })
            .catch(function () {
                errEl.textContent = '网络错误，请稍后重试';
                errEl.classList.add('show');
                btn.disabled = false;
                btn.textContent = '登录';
            });
        return false;
    };
})();



