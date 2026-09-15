import { Link } from 'react-router-dom';
import { Card } from '../components/ui';
import { useStore } from '../lib/store';
import { webSerialSupported } from '../lib/fc';

export function HomePage() {
  const { config, user } = useStore();
  const hero = (config?.content['home.hero'] as { title?: string; subtitle?: string; cta?: string } | undefined) ?? {};
  const help = (config?.content['help.web_serial'] as { text?: string } | undefined)?.text;
  return (
    <>
      <div className="hero">
        <h1>{hero.title ?? 'VTX Services'}</h1>
        <p>{hero.subtitle ?? 'Прошивка и настройка полётных контроллеров и пультов'}</p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <Link className="btn" to={user ? '/board' : '/connect'}>{hero.cta ?? 'Подключить борт'}</Link>
          {!user && <Link className="btn secondary" to="/auth">Регистрация</Link>}
        </div>
        {!webSerialSupported && <p className="warn" style={{ marginTop: 14 }}>{help ?? 'Ваш браузер не поддерживает Web Serial.'}</p>}
      </div>
      <div className="grid">
        <Card title="Мастер: борт не переключает каналы">Один путь: определяем FC → снимок до изменений → diff с подсказками → прошивка или диагностическое логирование → VTX и сетка → пульт TX12 MK2 → два артефакта → отчёт после полёта. <Link to="/wizard">Начать →</Link></Card>
        <Card title="Борт: прошивка и настройка FC">Идентификация, снимок «как было», diff/опции с подсказками, рабочая или диагностическая прошивка, анализ после полёта; AutoFlash и Diff-система — внутри. <Link to="/board">Открыть →</Link></Card>
        <Card title="VTX: автопереключение каналов">Определить VTX по сырым байтам MSP/CLI, добавить новый VTX с сеткой и фото, записать карту band/канал в борт. <Link to="/vtx">Открыть →</Link></Card>
        <Card title="Пульт: EdgeTX VtxAuto v3.1">Модель, пары band/канал, YAML модели, прошивка TX12 MK2 / TX12 / Pocket / Boxer, регистрация по UID. Борт не нужен; синхронизация с ним — по желанию. <Link to="/transmitter">Открыть →</Link></Card>
        <Card title="Эмуляторы">Виртуальный пульт и борт для обучения без железа. <Link to="/emulators">Открыть →</Link></Card>
        <Card title="Помощь">Telegram: <a href={`https://t.me/${(config?.telegram ?? '@SVYAT_2023').replace('@', '')}`} target="_blank" rel="noreferrer">{config?.telegram ?? '@SVYAT_2023'}</a> · <Link to="/news/feedback">Обратная связь</Link></Card>
      </div>
    </>
  );
}
