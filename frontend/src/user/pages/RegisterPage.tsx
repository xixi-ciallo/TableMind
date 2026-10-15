import { useState } from 'react';
import { Button, Form, Input, Typography, message } from 'antd';
import {
  IdcardOutlined,
  LockOutlined,
  MobileOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { register } from '../../shared/api/auth';
import { useAuthStore } from '../../stores/auth';
import { AuthSide, authShellStyle } from './authShared';
import BackButton from '../../shared/BackButton';

interface RegisterForm {
  username: string;
  phone: string;
  password: string;
  confirm: string;
}

export default function RegisterPage() {
  const navigate = useNavigate();
  const loginToStore = useAuthStore((s) => s.login);
  const [submitting, setSubmitting] = useState(false);

  const onFinish = async (values: RegisterForm) => {
    setSubmitting(true);
    try {
      // 手机号统一去掉空格与连字符后再提交，后端仍会再做一次格式校验
      const phone = values.phone.replace(/[\s-]/g, '').replace(/^\+86/, '');
      const res = await register({ username: values.username, phone, password: values.password });
      loginToStore(res.access_token, res.user);
      message.success('注册成功，欢迎加入 TableMind');
      navigate('/');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '注册失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={authShellStyle}>
      <AuthSide title="加入 TableMind 社区" subtitle="记录你的每一局游戏，分享评测，结识同好" />
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
            创建账号
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 26 }}>
            使用手机号注册，手机号将作为你的唯一账号标识
          </Typography.Paragraph>

          <Form<RegisterForm> layout="vertical" size="large" onFinish={onFinish} requiredMark={false}>
            <Form.Item
              label="用户名"
              name="username"
              rules={[
                { required: true, message: '请输入用户名' },
                { min: 2, max: 50, message: '用户名需 2-50 个字符' },
              ]}
            >
              <Input
                prefix={<UserOutlined style={{ color: 'var(--tm-text-tertiary)' }} />}
                placeholder="2-50 个字符，账号内唯一"
                autoComplete="username"
              />
            </Form.Item>

            <Form.Item
              label="手机号"
              name="phone"
              validateFirst
              rules={[
                { required: true, message: '请输入手机号' },
                {
                  validator: (_, v: string) => {
                    const p = (v ?? '').replace(/[\s-]/g, '').replace(/^\+86/, '');
                    return /^1[3-9]\d{9}$/.test(p)
                      ? Promise.resolve()
                      : Promise.reject(new Error('请输入 11 位中国大陆手机号'));
                  },
                },
              ]}
            >
              <Input
                prefix={<MobileOutlined style={{ color: 'var(--tm-text-tertiary)' }} />}
                placeholder="请输入手机号"
                inputMode="numeric"
                maxLength={13}
                autoComplete="tel"
              />
            </Form.Item>

            <Form.Item
              label="密码"
              name="password"
              rules={[
                { required: true, message: '请输入密码' },
                { min: 6, message: '密码至少 6 位' },
              ]}
            >
              <Input.Password
                prefix={<LockOutlined style={{ color: 'var(--tm-text-tertiary)' }} />}
                placeholder="至少 6 位"
                autoComplete="new-password"
              />
            </Form.Item>

            <Form.Item
              label="确认密码"
              name="confirm"
              dependencies={['password']}
              rules={[
                { required: true, message: '请再次输入密码' },
                ({ getFieldValue }) => ({
                  validator: (_, v) =>
                    !v || getFieldValue('password') === v
                      ? Promise.resolve()
                      : Promise.reject(new Error('两次输入的密码不一致')),
                }),
              ]}
            >
              <Input.Password
                prefix={<IdcardOutlined style={{ color: 'var(--tm-text-tertiary)' }} />}
                placeholder="再次输入密码"
                autoComplete="new-password"
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
              注册
            </Button>

            <div
              style={{
                marginTop: 16,
                textAlign: 'center',
                color: 'var(--tm-text-secondary)',
                fontSize: 13,
              }}
            >
              已有账号？<Link to="/login">去登录</Link>
            </div>
          </Form>
        </div>
      </div>
    </div>
  );
}
