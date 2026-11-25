create extension if not exists pgcrypto;

create table if not exists public.support_conversations (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null unique,
  nombre text not null,
  email text not null,
  ultimo_mensaje text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.support_chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.support_conversations(id) on delete cascade,
  sender_id uuid not null,
  sender_role text not null check (sender_role in ('user', 'admin')),
  mensaje text not null check (char_length(mensaje) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists support_chat_messages_conversation_created_idx
  on public.support_chat_messages (conversation_id, created_at);

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null,
  nombre_solicitante text not null,
  email_solicitante text not null,
  asunto text not null check (char_length(asunto) between 1 and 120),
  categoria text not null check (categoria in ('tecnica', 'cuenta', 'citas', 'otra')),
  descripcion text not null check (char_length(descripcion) between 15 and 2000),
  estado text not null default 'abierto'
    check (estado in ('abierto', 'en_proceso', 'resuelto', 'cerrado')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists support_tickets_user_created_idx
  on public.support_tickets (usuario_id, created_at desc);
create index if not exists support_tickets_status_created_idx
  on public.support_tickets (estado, created_at desc);

create table if not exists public.support_ticket_replies (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  sender_id uuid not null,
  sender_role text not null check (sender_role in ('user', 'admin')),
  mensaje text not null check (char_length(mensaje) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists support_ticket_replies_ticket_created_idx
  on public.support_ticket_replies (ticket_id, created_at);

alter table public.support_conversations enable row level security;
alter table public.support_chat_messages enable row level security;
alter table public.support_tickets enable row level security;
alter table public.support_ticket_replies enable row level security;

revoke all on public.support_conversations, public.support_chat_messages,
  public.support_tickets, public.support_ticket_replies from anon, authenticated;
grant all on public.support_conversations, public.support_chat_messages,
  public.support_tickets, public.support_ticket_replies to service_role;
