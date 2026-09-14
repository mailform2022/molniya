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
          <Link className="btn" to="/connect">{hero.cta ?? 'Подключить борт'}</Link>
          {!user && <Link className="btn secondary" to="/auth">Регистрация</Link>}
        </div>
        {!webSerialSupported && <p className="warn" style={{ marginTop: 14 }}>{help ?? 'Ваш браузер не поддерживает Web Serial.'}</p>}
      </div>
      <div className="grid">
        <Card title="AutoDetect VTX">Подключите борт — определим VTX по MSP/CLI, подберём сетку частот и сгенерируем diff. <Link to="/vtx">Открыть →</Link></Card>
        <Card title="AutoFlash">Пресеты прошивки INAV 7 + diff + OSD + VTX. Конвейерный режим для партий бортов. <Link to="/autoflash">Открыть →</Link></Card>
        <Card title="Diff-система">Эталонные diff, версии, откат, шаринг по ссылке, проверка конфликтов. <Link to="/diff">Открыть →</Link></Card>
        <Card title="Пульты">Прошивки VtxAuto v3.1 для RadioMaster TX16S / TX15 / TX12 / Pocket / Boxer. <Link to="/account/devices">Мои устройства →</Link></Card>
        <Card title="Эмуляторы">Виртуальный пульт и борт для обучения без железа. <Link to="/emulators">Открыть →</Link></Card>
        <Card title="Помощь">Telegram: <a href={`https://t.me/${(config?.telegram ?? '@SVYAT_2023').replace('@', '')}`} target="_blank" rel="noreferrer">{config?.telegram ?? '@SVYAT_2023'}</a> · <Link to="/news/feedback">Обратная связь</Link></Card>
      </div>
    </>
  );
}
