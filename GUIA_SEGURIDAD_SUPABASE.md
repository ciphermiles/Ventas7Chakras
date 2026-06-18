# Activacion de Seguridad en Supabase

Esta guia activa el modo seguro del sistema usando Supabase Auth y reglas RLS.

## 1. Antes de cambiar GitHub

Genera un respaldo manual desde el sistema actual.

## 2. Ejecutar SQL

En Supabase abre SQL Editor y ejecuta completo:

`supabase-cloud-schema.sql`

Ese archivo hace dos cambios importantes:

- Quita acceso anonimo publico a `pos_state`.
- Crea `pos_backups` para respaldos automaticos y manuales en nube.

## 3. Crear usuarios en Supabase Auth

En Supabase Authentication crea cuentas con estos correos:

- `master@ventas7chakras.local`
- `admin@ventas7chakras.local`
- `supervisor1@ventas7chakras.local`
- `supervisor2@ventas7chakras.local`
- `vendedor@ventas7chakras.local`

La contrasena de cada cuenta se define en Supabase Auth. Ya no se debe guardar en el sistema.

## 4. Activar modo seguro

Cuando las cuentas existan, copia el contenido de:

`cloud-config.secure.example.js`

y reemplaza el contenido de:

`cloud-config.js`

Despues coloca la anon public key real en `supabaseAnonKey`.

## 5. Subir a GitHub

Sube estos archivos:

- `app.js`
- `index.html`
- `cloud-config.js`
- `supabase-cloud-schema.sql`

## 6. Verificacion

Abre el sitio de GitHub Pages e inicia sesion con:

- Usuario: `master`
- Contrasena: la creada en Supabase Auth

Si aparece "Usuario o contrasena incorrectos", la cuenta de Supabase Auth no coincide con el correo esperado o la contrasena esta mal.
