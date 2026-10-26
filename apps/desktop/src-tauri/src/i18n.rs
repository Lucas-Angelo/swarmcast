//! Shell texts (tray, dialogs, splash) in English and Brazilian Portuguese.
//!
//! The language comes from the OS locale (`sys-locale`); `SWARMCAST_LOCALE` overrides it
//! (tests, or a user who wants the other language). Anything that is not Portuguese falls
//! back to English, like the panel does.

use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    En,
    PtBr,
}

/// `(key, text)` pairs. Placeholders are `{name}` and are filled by [`tr`].
type Dict = &'static [(&'static str, &'static str)];

const EN: Dict = &[
    ("tray.open", "Open SwarmCast"),
    ("tray.start", "Start live"),
    ("tray.stop", "Stop live"),
    ("tray.check_updates", "Check for updates"),
    ("tray.export_logs", "Export logs…"),
    ("tray.quit", "Quit"),
    ("tooltip.starting_app", "SwarmCast: starting…"),
    ("tooltip.off", "SwarmCast: off"),
    ("tooltip.starting", "SwarmCast: starting the live…"),
    ("tooltip.waiting", "SwarmCast: waiting for OBS"),
    ("tooltip.live_one", "SwarmCast: live · 1 viewer"),
    ("tooltip.live_many", "SwarmCast: live · {n} viewers"),
    ("tooltip.stopping", "SwarmCast: stopping…"),
    ("close.message", "The live is on. Closing stops it for everyone."),
    ("close.stop_quit", "Stop and quit"),
    ("close.keep", "Keep running in the tray"),
    ("update.title", "SwarmCast update"),
    ("update.available", "SwarmCast {version} is available (you have {current})."),
    ("update.live_warning", "The live is on: updating stops it for everyone."),
    ("update.notes", "What's new:"),
    ("update.now", "Update now"),
    ("update.later", "Later"),
    ("update.latest", "You have the latest version of SwarmCast ({current})."),
    ("update.check_failed", "Could not check for updates. Check your internet connection and try again later.\n\n({error})"),
    ("update.failed", "The update could not be installed. SwarmCast {current} keeps working: try again later.\n\n({error})"),
    ("update.ok", "OK"),
    ("splash.starting", "Starting SwarmCast…"),
    ("splash.hint", "This usually takes a few seconds."),
    ("splash.restarting", "SwarmCast stopped while starting. Trying again… ({n} of {max})"),
    ("splash.failed_title", "SwarmCast could not start"),
    ("splash.failed", "It stopped several times while starting. The logs folder has the details."),
    ("splash.crashed", "SwarmCast stopped unexpectedly. Restarting…"),
    ("splash.missing", "Part of SwarmCast is missing ({file}). Please reinstall SwarmCast."),
    ("splash.retry", "Try again"),
    ("splash.open_logs", "Open logs folder"),
    ("splash.stopping", "Closing SwarmCast…"),
    ("splash.stopping_hint", "Stopping the live and closing everything safely."),
    ("splash.update_preparing", "Preparing the update…"),
    ("splash.update_downloading", "Downloading the update…"),
    ("splash.update_retrying", "The download failed. Trying again… ({n} of {max})"),
    ("splash.update_installing", "Installing the update…"),
    ("splash.update_restarting", "Reopening SwarmCast…"),
    ("splash.update_hint", "Your settings are kept. SwarmCast reopens by itself."),
    ("fatal.title", "SwarmCast could not start"),
    (
        "fatal.already-running",
        "SwarmCast is already open in another window or in a terminal. Close it there first (in a terminal: Ctrl+C), then click Try again.",
    ),
    (
        "fatal.ports-busy",
        "Another program is using the ports SwarmCast needs (RTMP for OBS, or the panel). Close that program, then click Try again.",
    ),
    ("fatal.startup-failed", "Something went wrong while starting: {message}"),
    ("fatal.generic", "SwarmCast stopped with an error: {message}"),
    ("menu.about", "About SwarmCast"),
    ("menu.hide", "Hide SwarmCast"),
    ("menu.hide_others", "Hide Others"),
    ("menu.show_all", "Show All"),
    ("menu.quit", "Quit SwarmCast"),
    ("menu.edit", "Edit"),
    ("menu.undo", "Undo"),
    ("menu.redo", "Redo"),
    ("menu.cut", "Cut"),
    ("menu.copy", "Copy"),
    ("menu.paste", "Paste"),
    ("menu.select_all", "Select All"),
    ("menu.view", "View"),
    ("menu.reload", "Reload"),
    ("menu.window", "Window"),
    ("menu.minimize", "Minimize"),
    ("menu.zoom", "Zoom"),
    ("menu.close", "Close Window"),
];

const PT_BR: Dict = &[
    ("tray.open", "Abrir o SwarmCast"),
    ("tray.start", "Iniciar a live"),
    ("tray.stop", "Encerrar a live"),
    ("tray.check_updates", "Procurar atualizações"),
    ("tray.export_logs", "Exportar logs…"),
    ("tray.quit", "Sair"),
    ("tooltip.starting_app", "SwarmCast: abrindo…"),
    ("tooltip.off", "SwarmCast: desligado"),
    ("tooltip.starting", "SwarmCast: iniciando a live…"),
    ("tooltip.waiting", "SwarmCast: esperando o OBS"),
    ("tooltip.live_one", "SwarmCast: ao vivo · 1 espectador"),
    ("tooltip.live_many", "SwarmCast: ao vivo · {n} espectadores"),
    ("tooltip.stopping", "SwarmCast: encerrando…"),
    ("close.message", "A live está no ar. Se você fechar, ela acaba para todo mundo."),
    ("close.stop_quit", "Encerrar e sair"),
    ("close.keep", "Deixar rodando na bandeja"),
    ("update.title", "Atualização do SwarmCast"),
    ("update.available", "O SwarmCast {version} está disponível (você tem a versão {current})."),
    ("update.live_warning", "A live está no ar: atualizar agora encerra a live para todo mundo."),
    ("update.notes", "Novidades:"),
    ("update.now", "Atualizar agora"),
    ("update.later", "Depois"),
    ("update.latest", "Você já tem a versão mais recente do SwarmCast ({current})."),
    ("update.check_failed", "Não deu para procurar atualizações. Confira sua conexão com a internet e tente de novo mais tarde.\n\n({error})"),
    ("update.failed", "Não deu para instalar a atualização. O SwarmCast {current} continua funcionando: tente de novo mais tarde.\n\n({error})"),
    ("update.ok", "OK"),
    ("splash.starting", "Abrindo o SwarmCast…"),
    ("splash.hint", "Isso costuma levar só alguns segundos."),
    ("splash.restarting", "O SwarmCast parou enquanto abria. Tentando de novo… ({n} de {max})"),
    ("splash.failed_title", "O SwarmCast não conseguiu abrir"),
    ("splash.failed", "Ele parou várias vezes enquanto abria. Os detalhes estão na pasta de logs."),
    ("splash.crashed", "O SwarmCast parou de repente. Reabrindo…"),
    ("splash.missing", "Está faltando uma parte do SwarmCast ({file}). Instale o SwarmCast de novo."),
    ("splash.retry", "Tentar de novo"),
    ("splash.open_logs", "Abrir pasta de logs"),
    ("splash.stopping", "Fechando o SwarmCast…"),
    ("splash.stopping_hint", "Encerrando a live e fechando tudo com segurança."),
    ("splash.update_preparing", "Preparando a atualização…"),
    ("splash.update_downloading", "Baixando a atualização…"),
    ("splash.update_retrying", "O download falhou. Tentando de novo… ({n} de {max})"),
    ("splash.update_installing", "Instalando a atualização…"),
    ("splash.update_restarting", "Reabrindo o SwarmCast…"),
    ("splash.update_hint", "Suas configurações continuam salvas. O SwarmCast reabre sozinho."),
    ("fatal.title", "O SwarmCast não conseguiu abrir"),
    ("fatal.already-running", "O SwarmCast já está aberto em outra janela ou num terminal. Feche ele lá primeiro (no terminal: Ctrl+C) e depois clique em Tentar de novo."),
    ("fatal.ports-busy", "Outro programa está usando as portas de que o SwarmCast precisa (RTMP para o OBS, ou a do painel). Feche esse programa e depois clique em Tentar de novo."),
    ("fatal.startup-failed", "Algo deu errado ao abrir: {message}"),
    ("fatal.generic", "O SwarmCast parou com um erro: {message}"),
    ("menu.about", "Sobre o SwarmCast"),
    ("menu.hide", "Ocultar SwarmCast"),
    ("menu.hide_others", "Ocultar Outros"),
    ("menu.show_all", "Mostrar Tudo"),
    ("menu.quit", "Encerrar SwarmCast"),
    ("menu.edit", "Editar"),
    ("menu.undo", "Desfazer"),
    ("menu.redo", "Refazer"),
    ("menu.cut", "Recortar"),
    ("menu.copy", "Copiar"),
    ("menu.paste", "Colar"),
    ("menu.select_all", "Selecionar Tudo"),
    ("menu.view", "Visualizar"),
    ("menu.reload", "Recarregar"),
    ("menu.window", "Janela"),
    ("menu.minimize", "Minimizar"),
    ("menu.zoom", "Zoom"),
    ("menu.close", "Fechar Janela"),
];

/// Maps an OS locale (`pt-BR`, `pt_BR.UTF-8`, `en-US`…) to a shell language.
pub fn lang_for(locale: &str) -> Lang {
    if locale.to_ascii_lowercase().starts_with("pt") {
        Lang::PtBr
    } else {
        Lang::En
    }
}

/// Normalizes an OS locale to a BCP 47 tag (`pt_BR.UTF-8` → `pt-BR`), for the webview
/// and for the server (`SWARMCAST_LOCALE`).
pub fn normalize_locale(raw: &str) -> String {
    let base = raw.split(['.', '@']).next().unwrap_or("").trim().replace('_', "-");
    if base.is_empty() || base.eq_ignore_ascii_case("C") || base.eq_ignore_ascii_case("POSIX") {
        return "en-US".into();
    }
    let mut parts = base.split('-');
    let lang = parts.next().unwrap_or("en").to_ascii_lowercase();
    match parts.next() {
        Some(region) if region.len() == 2 => format!("{lang}-{}", region.to_ascii_uppercase()),
        Some(other) => format!("{lang}-{other}"),
        None => lang,
    }
}

/// The OS locale as a BCP 47 tag, honoring `SWARMCAST_LOCALE`.
pub fn locale() -> &'static str {
    static LOCALE: OnceLock<String> = OnceLock::new();
    LOCALE.get_or_init(|| {
        let raw = std::env::var("SWARMCAST_LOCALE")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or_else(sys_locale::get_locale)
            .unwrap_or_else(|| "en-US".into());
        normalize_locale(&raw)
    })
}

pub fn lang() -> Lang {
    lang_for(locale())
}

fn dict(lang: Lang) -> Dict {
    match lang {
        Lang::En => EN,
        Lang::PtBr => PT_BR,
    }
}

fn lookup(lang: Lang, key: &str) -> &'static str {
    dict(lang).iter().chain(EN.iter()).find(|(k, _)| *k == key).map(|(_, v)| *v).unwrap_or("")
}

/// Text for `key` in `lang` with `{name}` placeholders filled.
pub fn tr_in(lang: Lang, key: &str, args: &[(&str, &str)]) -> String {
    let mut s = lookup(lang, key).to_string();
    for (name, value) in args {
        s = s.replace(&format!("{{{name}}}"), value);
    }
    s
}

/// Text for `key` in the OS language.
pub fn tr(key: &str, args: &[(&str, &str)]) -> String {
    tr_in(lang(), key, args)
}

pub fn t(key: &str) -> String {
    tr(key, &[])
}

/// Whether `key` exists (used for `fatal.<code>`).
pub fn has(key: &str) -> bool {
    EN.iter().any(|(k, _)| *k == key)
}

/// All splash texts, sent to the splash page so it does not need its own dictionary.
pub fn splash_texts() -> serde_json::Map<String, serde_json::Value> {
    dict(lang())
        .iter()
        .filter(|(k, _)| k.starts_with("splash."))
        .map(|(k, v)| (k.trim_start_matches("splash.").to_string(), serde_json::Value::from(*v)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn keys(d: Dict) -> BTreeSet<&'static str> {
        d.iter().map(|(k, _)| *k).collect()
    }

    fn placeholders(s: &str) -> BTreeSet<String> {
        s.split('{').skip(1).filter_map(|p| p.split_once('}').map(|(n, _)| n.to_string())).collect()
    }

    #[test]
    fn en_and_pt_br_have_the_same_keys() {
        assert_eq!(keys(EN), keys(PT_BR));
        assert_eq!(keys(EN).len(), EN.len(), "duplicate key in EN");
        assert_eq!(keys(PT_BR).len(), PT_BR.len(), "duplicate key in PT_BR");
    }

    #[test]
    fn translations_keep_the_placeholders() {
        for (key, en) in EN {
            let pt = PT_BR.iter().find(|(k, _)| k == key).unwrap().1;
            assert_eq!(placeholders(en), placeholders(pt), "placeholders differ for {key}");
            assert!(!pt.trim().is_empty(), "empty pt-BR text for {key}");
        }
    }

    #[test]
    fn picks_the_language_from_the_locale() {
        assert_eq!(lang_for("pt-BR"), Lang::PtBr);
        assert_eq!(lang_for("pt_PT.UTF-8"), Lang::PtBr);
        assert_eq!(lang_for("en-US"), Lang::En);
        assert_eq!(lang_for("de-DE"), Lang::En);
    }

    #[test]
    fn normalizes_locales() {
        assert_eq!(normalize_locale("pt_BR.UTF-8"), "pt-BR");
        assert_eq!(normalize_locale("en-us"), "en-US");
        assert_eq!(normalize_locale("C"), "en-US");
        assert_eq!(normalize_locale("zh-Hans-CN"), "zh-Hans");
        assert_eq!(normalize_locale("fr"), "fr");
    }

    #[test]
    fn fills_placeholders() {
        assert_eq!(tr_in(Lang::En, "tooltip.live_many", &[("n", "3")]), "SwarmCast: live · 3 viewers");
        assert_eq!(
            tr_in(Lang::PtBr, "update.available", &[("version", "0.3.0"), ("current", "0.2.0")]),
            "O SwarmCast 0.3.0 está disponível (você tem a versão 0.2.0)."
        );
    }
}
