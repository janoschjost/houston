#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity;
mod aliases;
mod limits;
mod pty;
mod remote;
mod shell;
mod ssh;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Emitter;

fn main() {
    // ssh runs Houston as its askpass helper to log in with a password saved in the Keychain.
    if let Ok(account) = std::env::var(ssh::ASKPASS_ENV) {
        std::process::exit(ssh::askpass(&account));
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(pty::Ptys::default())
        .setup(|app| {
            shell::init(app.handle())?;
            ssh::clear_edits();
            limits::init(app.handle())?;
            // Custom menu: keeps Edit (clipboard) but drops the default ⌘W/⌘N items so the app owns them.
            let h = app.handle();
            let menu = Menu::with_items(
                h,
                &[
                    &Submenu::with_items(
                        h,
                        "Houston",
                        true,
                        &[
                            &PredefinedMenuItem::about(h, None, None)?,
                            &MenuItem::with_id(h, "check-updates", "Check for Updates…", true, None::<&str>)?,
                            &PredefinedMenuItem::separator(h)?,
                            &PredefinedMenuItem::hide(h, None)?,
                            &PredefinedMenuItem::hide_others(h, None)?,
                            &PredefinedMenuItem::separator(h)?,
                            &PredefinedMenuItem::quit(h, None)?,
                        ],
                    )?,
                    &Submenu::with_items(
                        h,
                        "Edit",
                        true,
                        &[
                            &PredefinedMenuItem::undo(h, None)?,
                            &PredefinedMenuItem::redo(h, None)?,
                            &PredefinedMenuItem::separator(h)?,
                            &PredefinedMenuItem::cut(h, None)?,
                            &PredefinedMenuItem::copy(h, None)?,
                            &PredefinedMenuItem::paste(h, None)?,
                            &PredefinedMenuItem::select_all(h, None)?,
                        ],
                    )?,
                    &Submenu::with_items(
                        h,
                        "Window",
                        true,
                        &[&PredefinedMenuItem::minimize(h, None)?, &PredefinedMenuItem::fullscreen(h, None)?],
                    )?,
                ],
            )?;
            app.set_menu(menu)?;
            // App menu items the frontend handles; it owns the update flow.
            app.on_menu_event(|app, event| {
                if event.id() == "check-updates" {
                    let _ = app.emit("menu", "check-updates");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            shell::shell_info,
            shell::complete_path,
            shell::git_refs,
            shell::git_status,
            shell::git_diff,
            shell::git_head_file,
            shell::read_project_file,
            shell::write_project_file,
            shell::launch_detached,
            shell::npm_scripts,
            shell::installed_apps,
            shell::claude_session_exists,
            shell::load_state,
            shell::save_state,
            limits::claude_status_line,
            limits::claude_limits,
            limits::claude_session_stats,
            activity::claude_timeline,
            activity::claude_edits,
            remote::remote_start,
            remote::remote_stop,
            remote::remote_update,
            aliases::list_aliases,
            aliases::save_alias,
            aliases::delete_alias,
            ssh::ssh_hosts,
            ssh::ssh_command,
            ssh::sftp_list,
            ssh::sftp_download,
            ssh::sftp_upload,
            ssh::sftp_mkdir,
            ssh::sftp_remove,
            ssh::sftp_rename,
            ssh::sftp_save_password,
            ssh::sftp_forget_password,
            ssh::local_list,
            ssh::sftp_edit,
            ssh::edit_reopen,
            ssh::edit_mtime,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Houston");
}
