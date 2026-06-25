# Manual de Uso - Punto de Venta 7 Chakras

## Acceso

Abre el sistema desde el enlace publicado.

Usuarios principales:

- `master`
- `admin`
- `supervisor1`
- `supervisor2`
- `vendedor`

Las contrasenas se administran en Supabase Authentication.

## Abrir caja

1. Inicia sesion.
2. Entra a `Caja`.
3. Escribe el monto inicial de efectivo.
4. Presiona `Abrir caja`.

Sin caja abierta no se pueden realizar ventas.

## Realizar venta

1. Entra a `Punto de venta`.
2. Escanea el codigo o busca el producto.
3. Agrega productos a la cuenta.
4. Ajusta cantidades si es necesario.
5. Presiona `Cobrar`.
6. Escribe el folio de la nota.
7. Selecciona forma de pago: efectivo, tarjeta o transferencia.
8. Confirma la venta.

Si el folio ya existe, el sistema preguntara si se desea agregar productos a ese folio y pedira autorizacion.

## Registrar gasto

1. Entra a `Gastos`.
2. Escribe descripcion y monto.
3. Presiona `Registrar gasto`.
4. Si eres vendedor, ingresa token o clave autorizada.

Los gastos se descuentan del corte de caja.

## Devoluciones y cancelaciones

Las devoluciones parciales y cancelaciones requieren autorizacion.

1. Entra a `Ventas`.
2. Busca la venta.
3. Elige `Devolucion` o `Cancelar`.
4. Ingresa token, clave autorizada o credenciales permitidas segun configuracion.

## Cerrar caja / corte

El cierre de caja requiere token temporal.

1. Pide a un administrador o supervisor generar un token en `Autorizaciones`.
2. Entra a `Caja`.
3. Presiona `Cerrar caja / corte con token`.
4. Ingresa el token.
5. Confirma.

No se puede cerrar sesion si la caja sigue abierta.

## Agregar producto

1. Entra a `Productos`.
2. Presiona `Agregar producto`.
3. Captura nombre, codigo, tipo, costo, precio y stock minimo.
4. Elige si se maneja por piezas, paquetes/cajas o peso.
5. Si aplica, captura presentaciones de venta.
6. Guarda.

Para productos por peso se puede registrar en kilos, gramos o miligramos.

## Tipos y mayoreo

El mayoreo normal se configura por tipo de producto, no por producto individual.

Ejemplo: si el tipo `Veladora de aroma` tiene mayoreo desde 10 unidades con precio de $25, el sistema aplica ese precio cuando la cuenta suma 10 o mas unidades entre productos de ese mismo tipo.

Para configurarlo:

1. Entra a `Productos`.
2. Presiona `Tipos y mayoreo`.
3. Edita el tipo de producto.
4. Captura `Mayoreo desde cuantas unidades` y `Precio por unidad en mayoreo`.
5. Guarda.

Si no quieres mayoreo para un tipo, deja ambos campos en 0.

## Presentaciones de venta

Las presentaciones son opcionales. Sirven para vender el mismo producto por paquete, caja, kilo, gramos o una presentacion especial sin duplicarlo en inventario.

Formato:

`Nombre | cantidad que descuenta del inventario | precio | minimo opcional`

Ejemplos:

`Paquete de 12 | 12 | 100`

`Caja de 10 paquetes | 120 | 900`

`100 g | 100 | 45`

`1 kg | 1000 | 380`

La cantidad siempre se interpreta en la unidad base del producto. Si el producto se guarda en gramos, `1 kg` debe capturarse como `1000`.

## Entrada de inventario

1. En `Productos`, busca el producto.
2. Presiona `Entrada`.
3. Elige si recibes unidades, cajas, paquetes, kilos, gramos o miligramos.
4. Captura cantidad y costo.
5. Guarda.

Si se captura costo por caja o kilo, el sistema calcula el costo unitario real.

## Respaldos

1. Entra a `Respaldos`.
2. Presiona `Generar respaldo`.
3. Guarda el archivo JSON descargado.

Tambien se pueden consultar respaldos guardados en nube con `Actualizar lista nube`.

## Reportes

En `Reportes` puedes consultar:

- Ventas por rango de fechas.
- Ganancia neta.
- Efectivo, tarjeta y transferencia.
- Productos mas vendidos.
- Ventas por usuario.
- Detalle de productos y gastos.

## Recomendaciones de operacion

- Hacer corte al terminar cada turno.
- Generar respaldo antes de cambios grandes.
- No compartir contrasenas.
- Usar tokens temporales para autorizaciones.
- Revisar productos con stock bajo al inicio del dia.
