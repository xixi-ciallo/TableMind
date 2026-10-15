import { useState } from 'react';
import { Button, Form, Input, Typography, message } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { login } from '../../shared/api/auth';
import { useAuthStore } from '../../stores/auth';
import { AuthSide, authShellStyle } from './authShared';
import BackButton from '../../shared/BackButton';

interface LoginForm {
  username: string;
  password: string;
}

export default function LoginPage() {
  const navigate = useNavigate();
  const loginToStore = useAuthStore((s) => s.login);
  const [submitting, setSubmitting] = useState(false);

  const onFinish = async (values: LoginForm) => {
    setSubmitting(true);
    try {
      const res = await login({ username: values.username.trim(), password: values.password });
      loginToStore(res.access_token, res.user);
      message.success('登录成功');
      if (res.user.role === 'admin') {
        navigate('/admin');
      } else {
        navigate('/');
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={authShellStyle}>
      <AuthSide
        title="发现你的下一款桌游"
        subtitle="收录真实桌游资料 · 真实玩家评测 · AI 规则助手"
      />
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          position: 'relative',
        }}
      >
        <BackButton
          label="返回"
          fallback="/"
          variant="solid"
          style={{ position: 'absolute', left: 20, top: 20 }}
        />
        <div style={{ width: 380 }} className="tm-page-enter">
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            欢迎回来
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 26 }}>
            用用户名或注册手机号登录
          </Typography.Paragraph>

          <Form<LoginForm> layout="vertical" size="large" onFinish={onFinish} requiredMark={false}>
            <Form.Item
              label="用户名 / 手机号"
              name="username"
              rules={[{ required: true, message: '请输入用户名或手机号' }]}
            >
              <Input
                prefix={<UserOutlined style={{ color: 'var(--tm-text-tertiary)' }} />}
                placeholder="用户名或手机号"
                autoComplete="username"
              />
            </Form.Item>

            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password
                prefix={<LockOutlined style={{ color: 'var(--tm-text-tertiary)' }} />}
                placeholder="请输入密码"
                autoComplete="current-password"
              />
            </Form.Item>

            <Button
              type="primary"
              htmlType="submit"
              block
              size="large"
              loading={submitting}
              style={{ marginTop: 4 }}
            >
              登录
            </Button>

            <div
              style={{
                marginTop: 16,
                textAlign: 'center',
                color: 'var(--tm-text-secondary)',
                fontSize: 13,
              }}
            >
              还没有账号？<Link to="/register">立即注册</Link>
            </div>
          </Form>
        </div>
      </div>
    </div>
  );
}
