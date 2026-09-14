/** PaymentProvider interface + stubs. Real YooKassa/Stripe integrations plug in here when API keys arrive. */

export interface PaymentResult {
  ok: boolean;
  provider: string;
  paymentId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  redirectUrl?: string;
  message?: string;
}

export interface PaymentProvider {
  readonly name: 'yookassa' | 'stripe' | 'manual';
  createPayment(amountRub: number, description: string, meta: Record<string, string>): Promise<PaymentResult>;
  createSubscription(planCode: string, amountRub: number, meta: Record<string, string>): Promise<PaymentResult>;
  checkStatus(paymentId: string): Promise<PaymentResult>;
  handleWebhook(body: unknown, headers: Record<string, string | string[] | undefined>): Promise<{ paymentId: string; status: PaymentResult['status'] } | null>;
  refund(paymentId: string, amountRub?: number): Promise<PaymentResult>;
}

class StubProvider implements PaymentProvider {
  constructor(
    public readonly name: PaymentProvider['name'],
    private readonly configured: boolean
  ) {}
  private notReady(id = 'stub'): PaymentResult {
    return { ok: false, provider: this.name, paymentId: id, status: 'failed', message: `${this.name}: провайдер ещё не подключён (ожидаем API-ключи)` };
  }
  async createPayment(amountRub: number, description: string, meta: Record<string, string>): Promise<PaymentResult> {
    if (this.name === 'manual') {
      return { ok: true, provider: 'manual', paymentId: `manual_${Date.now()}`, status: 'pending', message: `Оплата вручную: ${amountRub} ₽ — ${description} (${meta.userId ?? ''})` };
    }
    return this.configured ? { ok: true, provider: this.name, paymentId: `${this.name}_${Date.now()}`, status: 'pending', redirectUrl: undefined } : this.notReady();
  }
  createSubscription(planCode: string, amountRub: number, meta: Record<string, string>): Promise<PaymentResult> {
    return this.createPayment(amountRub, `Подписка ${planCode}`, meta);
  }
  async checkStatus(paymentId: string): Promise<PaymentResult> {
    return { ok: true, provider: this.name, paymentId, status: 'pending' };
  }
  async handleWebhook(): Promise<null> {
    return null;
  }
  async refund(paymentId: string): Promise<PaymentResult> {
    return this.configured ? { ok: true, provider: this.name, paymentId, status: 'refunded' } : this.notReady(paymentId);
  }
}

export function getProvider(name: PaymentProvider['name'], keys: { stripe?: string; yookassa?: string }): PaymentProvider {
  switch (name) {
    case 'stripe':
      return new StubProvider('stripe', Boolean(keys.stripe && !keys.stripe.endsWith('stub')));
    case 'yookassa':
      return new StubProvider('yookassa', Boolean(keys.yookassa && keys.yookassa !== 'stub'));
    default:
      return new StubProvider('manual', true);
  }
}
