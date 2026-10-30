#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity;
mod aliases;
mod limits;
mod pty;
mod remote;
mod shell;

use tauri::menu::{Menu, PredefinedMenuItem, Submenu};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(pty::Ptys::default())
        .setup(|app| {
            shell::init(app.handle())?;
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Houston");
}
