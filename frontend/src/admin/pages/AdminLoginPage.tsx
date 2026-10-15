import { useEffect, useState } from 'react';
import { Alert, Button, Form, Input } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { login } from '../../shared/api/auth';
import { useAuthStore } from '../../stores/auth';
import { useIsMobile } from '../../shared/useIsMobile';
import BackButton from '../../shared/BackButton';

interface AdminLoginForm {
  username: string;
  password: string;
}

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const token = useAuthStore((s) => s.token);
  const role = useAuthStore((s) => s.user?.role);
  const loginToStore = useAuthStore((s) => s.login);

  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // 已是管理员且在有效期内：直接进后台，避免在登录页重复登录
  useEffect(() => {
    if (token && role === 'admin') {
      navigate('/admin', { replace: true });
    }
  }, [token, role, navigate]);

  const onFinish = async (values: AdminLoginForm) => {
    setSubmitting(true);
    setErrorText(null);
    try {
      const res = await login({ username: values.username.trim(), password: values.password });
      if (res.user.role !== 'admin') {
        setErrorText(`账号「${res.user.username}」不是管理员，无法进入管理端`);
        return;
      }
      loginToStore(res.access_token, res.user);
      navigate('/admin', { replace: true });
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        background: 'var(--tm-surface-card)',
      }}
    >
      {/* 品牌面板：窄屏降级为顶部条，避免左侧 420px 固定宽度挤爆布局 */}
      <div
        style={{
          width: isMobile ? 'auto' : 420,
          flexShrink: 0,
          padding: isMobile ? '28px 24px 34px' : 48,
          background:
            'linear-gradient(160deg, var(--tm-brand-light) 0%, var(--tm-brand) 55%, var(--tm-action) 100%)',
          color: '#fff',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute',
            right: -70,
            top: -70,
            width: 240,
            height: 240,
            borderRadius: '50%',
            background: 'rgba(255,255,255,.14)',
          }}
        />
        <div style={{ position: 'relative' }}>
          <div style={{ fontSize: isMobile ? 26 : 34, fontWeight: 800, letterSpacing: 1, marginBottom: 14 }}>
            TableMind
          </div>
          <div style={{ fontSize: isMobile ? 17 : 20, fontWeight: 600, marginBottom: 10 }}>
            管理控制台
          </div>
          <div style={{ color: 'rgba(255,255,255,.9)', fontSize: 14, lineHeight: 1.8 }}>
            桌游资料维护 · 用户与权限管理 · 内容审核 · 数据洞察
          </div>
        </div>
      </div>

      {/* 表单区 */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: isMobile ? '28px 20px 40px' : 24,
          position: 'relative',
          minWidth: 0,
        }}
      >
        {isMobile && (
          <div style={{ position: 'absolute', left: 16, top: 16 }}>
            <BackButton label="返回前台" fallback="/" variant="solid" />
          </div>
        )}

        <div style={{ width: '100%', maxWidth: 380, marginTop: isMobile ? 44 : 0 }} className="tm-page-enter">
          <h1 style={{ margin: 0, fontSize: isMobile ? 21 : 24, fontWeight: 800 }}>
            管理员登录
          </h1>
          <p style={{ margin: '6px 0 22px', color: 'var(--tm-text-secondary)', fontSize: 13.5 }}>
            请使用具备 admin 角色的账号登录
          </p>

          {errorText && (
            <Alert
              type="error"
              showIcon
              message={errorText}
              style={{ marginBottom: 16, borderRadius: 'var(--tm-radius-md)' }}
            />
          )}

          <Form<AdminLoginForm>
            layout="vertical"
            size="large"
            onFinish={onFinish}
            requiredMark={false}
            disabled={submitting}
          >
            <Form.Item
              label="管理员账号"
              name="username"
              rules={[{ required: true, message: '请输入用户名或手机号' }]}
            >
              <Input
                prefix={<UserOutlined style={{ color: 'var(--tm-text-tertiary)' }} />}
                placeholder="用户名或手机号"
                autoComplete="username"
                allowClear
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
              登录管理端
            </Button>
          </Form>

          {!isMobile && (
            <div style={{ marginTop: 20 }}>
              <BackButton label="返回前台首页" fallback="/" variant="ghost" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
