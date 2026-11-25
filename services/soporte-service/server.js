require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const supabase = require('./db');
const {
  pushConfigured,
  pushPublicKey,
  defaultPreferences,
  getPreferences,
  sendPush,
  notifyUser,
  notifyAdmins,
  startReminderScheduler
} = require('./notifications');

if (!process.env.JWT_SECRET) {
  throw new Error('Falta la variable de entorno JWT_SECRET');
}

const app = express();
const PORT = process.env.PORT || 3010;
const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:4200').replace(/\/$/, '');
const ticketStatuses = ['abierto', 'en_proceso', 'resuelto', 'cerrado'];
const ticketCategories = [
  'tecnica',
  'cuenta',
  'citas',
  'estudios',
  'tratamientos',
  'documentos',
  'otro'
];

app.use(cors({ origin: frontendUrl, credentials: true }));
app.use(express.json({ limit: '20kb' }));

function authenticate(req, res, next) {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Token no proporcionado' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    console.warn('JWT rechazado por soporte:', error.name);
    return res.status(401).json({ success: false, error: 'Token inválido o expirado' });
  }

  if (!decoded.id) {
    return res.status(401).json({ success: false, error: 'Token sin usuario válido' });
  }

  return supabase
    .from('usuarios')
    .select('id, nombre, apellido, email, rol, activo')
    .eq('id', decoded.id)
    .single()
    .then(({ data: user, error }) => {
      if (error && error.code !== 'PGRST116') {
        console.error('Error consultando usuario en Supabase:', error);
        return res.status(500).json({ success: false, error: 'No se pudo validar el usuario en la base de datos' });
      }
      if (!user) {
        return res.status(401).json({ success: false, error: 'Usuario no encontrado' });
      }
      if (user.activo === false) {
        return res.status(403).json({ success: false, error: 'Usuario desactivado' });
      }

      req.user = user;
      return next();
    })
    .catch(error => {
      console.error('Error verificando usuario:', error);
      return res.status(500).json({ success: false, error: 'No se pudo validar la sesión' });
    });
}

function requireAdmin(req, res, next) {
  if (req.user?.rol !== 'admin') {
    return res.status(403).json({ success: false, error: 'Se requiere una cuenta de administrador' });
  }
  return next();
}

function readMessage(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isNotificationsSchemaMissing(error) {
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || error?.code === 'PGRST204';
}

function notificationSchemaUnavailable(res) {
  return res.status(503).json({
    success: false,
    code: 'NOTIFICATIONS_SCHEMA_MISSING',
    error: 'Falta crear las tablas de notificaciones. Ejecuta migrations/20261125-notifications.sql en el proyecto de Supabase que usa soporte-service.'
  });
}

function automaticReply(message) {
  const normalized = message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const reply = answer => `Respuesta automática: ${answer}`;
  const matches = pattern => pattern.test(normalized);
  const asksAboutAppointment = matches(/\b(cita|citas|consulta|consultas|agenda|agendar|agendamiento)\b/);
  const asksAboutStudy = matches(/\b(estudio|estudios|laboratorio|laboratorios|analisis|examen|examenes|prueba|pruebas|resultado|resultados)\b/);
  const asksAboutTreatment = matches(/\b(tratamiento|tratamientos|medicamento|medicamentos|medicina|medicinas|medicacion|toma|tomas|dosis|pastilla|pastillas)\b/)
    || (matches(/\b(frecuencia)\b/) && !asksAboutAppointment);
  const asksAboutDocuments = matches(/\b(documento|documentos|archivo|archivos|pdf|receta|informe|foto|fotos|imagen|imagenes|camara)\b/);
  const asksAboutChat = matches(/\b(chat|chatbox|conversacion|conversaciones)\b/);

  if (/^(?:(?:hola+|hello|hi|buenas(?:\s+(?:noches|tardes|dias))?|buenos\s+dias|hey|que\s+tal|que\s+onda|saludos)\s*)+(?:[, ]+\s*(?:gracias|muchas\s+gracias))?[!.?\s]*$/.test(normalized)) {
    return reply('¡Hola! Puedo orientarte sobre tratamientos, citas, estudios, documentos, tu cuenta y Soporte. Pregúntame con tus propias palabras; por ejemplo: “¿Cómo cancelo una cita?” o “¿Dónde subo un resultado?”.');
  }

  if (/^(?:(?:ok|perfecto)\s*,?\s*)?(gracias|muchas\s+gracias|mil\s+gracias|thanks|thank\s+you|te\s+lo\s+agradezco|te\s+agradezco|gracias\s+por\s+tu\s+ayuda|muchas\s+gracias\s+por\s+todo)[!.?\s]*$/.test(normalized)) {
    return reply('¡Con gusto! Si necesitas otra cosa, dime qué intentas hacer o en qué sección estás y te guío.');
  }

  if (/^(adios|hasta\s+luego|nos\s+vemos|bye)[!.?\s]*$/.test(normalized)) {
    return reply('¡Hasta luego! Aquí estaré si necesitas ayuda con Sel Kalis.');
  }

  if (/^(ayuda|help|menu|guia|me puedes ayudar|necesito ayuda|ayuda por favor)[!.?\s]*$/.test(normalized)
    || matches(/\b(que puedo pregunt\w*|que preguntas puedo hacer|como te pregunto|como pregunto|no se que preguntar|no se como preguntar|ejemplos de preguntas|dame ejemplos|como pregunt\w* al chat|como usar el chat|como usar la aplicacion|como funciona el chat|guia del sistema|guia de uso|guia de sel kalis|que puedes hacer|para que sirve el chat|como me puedes ayudar)\b/)) {
    return reply('Puedes escribir una pregunta normal, sin comandos especiales. Te puedo guiar para registrar o cancelar citas, crear tratamientos, marcar tomas, agendar estudios, subir documentos, recuperar acceso y usar Soporte. Ejemplos: “No puedo entrar”, “¿Cómo agrego un medicamento?”, “¿Cómo veo mis estudios?” o “¿Cómo reporto un error?”. Si no tengo una respuesta útil, tu consulta se enviará a la bandeja de soporte para que la atienda una persona.');
  }

  if (asksAboutAppointment && asksAboutDocuments && matches(/\b(adjunt\w*|asociar|vincular)\b/)) {
    return reply('Las citas no tienen un campo para adjuntar archivos. Sube el archivo desde Documentos y selecciona la categoría “Estudio” si corresponde; puedes incluir la fecha o el nombre de la cita en la descripción.');
  }

  if (matches(/\b(emergencia|no puedo respirar|dificultad para respirar|falta el aire|dolor en el pecho|sangrado abundante|desmayo)\b/)) {
    return reply('Esto puede requerir atención inmediata. No uses el chat para emergencias: contacta los servicios de emergencia locales o acude a urgencias.');
  }

  if (matches(/\b(que debo tomar|que puedo tomar|que tomar|que medicamento|que medicina|que medicinas|cuanta dosis|que dosis|dosis correcta|efectos secundarios|reaccion alergica|interaccion de medicamentos|mezclar medicamentos|combinar medicamentos|como curar|tratamiento para|medicina para|remedio para|me duele|tengo fiebre|tengo dolor|sintoma\w*|alergia|alergico|alergica|diagnostico medico)\b/)) {
    return reply('No puedo diagnosticar ni recomendar medicamentos o dosis. Consulta a tu médico o farmacéutico. Sel Kalis sirve para registrar y organizar indicaciones que ya recibiste; no sustituye la atención médica.');
  }

  if (asksAboutDocuments) {
    if (matches(/\b(elimin\w*|borr\w*)\b/)) {
      return reply('En Documentos, pulsa el icono de papelera junto al archivo y confirma la eliminación.');
    }

    if (matches(/\b(descarg\w*)\b/)) {
      return reply('En Documentos, pulsa el icono de descarga junto al archivo. También puedes abrirlo: las imágenes y los PDF tienen vista previa y botón “Descargar”.');
    }

    if (matches(/\b(subir|subo|cargo|cargar|adjuntar|camara|foto)\b/)) {
      return reply('Abre Documentos > “Subir documento”, elige una imagen o PDF (máximo 50 MB) o toma una foto con la cámara. Escribe el nombre, selecciona categoría (Receta, Estudio, Informe u Otro) y, si quieres, agrega una descripción; después pulsa “Subir documento”.');
    }

    if (matches(/\b(error|problema|no puedo|no me deja|falla|no aparece|no encuentro|no carga|no funciona)\b/)) {
      return reply('Verifica que el archivo sea una imagen o PDF de máximo 50 MB y que tenga nombre. Si sigue fallando, registra una incidencia en Soporte > “Nueva incidencia” con el error y los pasos que seguiste; elige “Documentos”.');
    }

    return reply('En Documentos puedes buscar, filtrar por categoría, previsualizar imágenes y PDF, descargar archivos y eliminar los que ya no necesites.');
  }

  if (asksAboutTreatment) {
    if (matches(/\b(elimin\w*|borr\w*)\b/)) {
      return reply('En Tratamientos no hay una opción para borrar definitivamente. Puedes suspender un tratamiento o medicamento desde sus acciones; el chat no recomienda suspenderlo y debes seguir las indicaciones de tu profesional de salud.');
    }

    if (matches(/\b(olvide|omiti|se me paso|perdi|me salte)\b/) && matches(/\b(toma|dosis|medicamento)\b/)) {
      return reply('En Tratamientos, cada toma solo se puede marcar desde la hora programada y hasta 30 minutos después. Si pasó ese margen, la app no permite registrarla; consulta a tu profesional de salud sobre qué hacer con una dosis omitida.');
    }

    if (matches(/\b(marc\w*|registr\w*|anot\w*|tomad\w*|toma de hoy)\b/) && matches(/\b(toma|dosis|medicamento|pastilla)\b/)) {
      return reply('Abre Tratamientos, despliega el tratamiento y busca “Tomas de hoy”. Pulsa “Pendiente” en la toma correspondiente entre la hora programada y los 30 minutos siguientes; después aparecerá como “Tomada”.');
    }

    if (matches(/\b(historial|registro anterior|ajustes anteriores)\b/)) {
      return reply('En Tratamientos, despliega el tratamiento y pulsa “Historial”; cada medicamento también tiene su propio botón “Historial” para consultar los ajustes registrados.');
    }

    if (matches(/\b(reactiv\w*|reanudar)\b/)) {
      return reply('En Tratamientos, filtra por “Suspendidos” y pulsa “Reactivar” junto al tratamiento. Para un medicamento suspendido, abre su tratamiento y usa “Reactivar” en la tarjeta del medicamento.');
    }

    if (matches(/\b(suspend\w*|pausar)\b/)) {
      return reply('En Tratamientos puedes suspender un tratamiento activo desde su tarjeta, o suspender un medicamento desde sus acciones. La app pide una razón. Haz cambios solo conforme a indicaciones de tu profesional de salud; el chat no recomienda suspender medicamentos.');
    }

    if (matches(/\b(edit\w*|modific\w*)\b/) && matches(/\b(medicamento|medicamentos)\b/)) {
      return reply('En Tratamientos, despliega un tratamiento activo y pulsa el icono de edición del medicamento. La opción aparece mientras el tratamiento y el medicamento están activos y el tratamiento está en curso.');
    }

    if (matches(/\b(frecuencia|extender|duracion|ajust\w*)\b/) && matches(/\b(cambiar|modific\w*|extender|aumentar|reducir|ajust\w*|como|donde)\b/)) {
      return reply('En Tratamientos, despliega el tratamiento y usa “Frecuencia” o “Extender” en el medicamento; se solicita una razón médica. La app registra el cambio, pero no determina si es seguro: aplícalo únicamente si así te lo indicó tu profesional de salud.');
    }

    if (matches(/\b(nuev\w*\s+tratamiento|tratamiento\s+nuev\w*|crear\w*\s+(un\s+)?tratamiento|registr\w*\s+(un\s+)?tratamiento|agreg\w*\s+(un\s+)?tratamiento|anadir\s+(un\s+)?tratamiento)\b/)) {
      return reply('Abre Tratamientos > “Nuevo tratamiento”. Escribe el nombre y agrega al menos un medicamento; la fecha de inicio y la hora se asignan automáticamente. Para cada medicamento captura nombre, frecuencia y duración (mínimo 1 día); concentración, dosis e instrucciones son opcionales. Pulsa “Guardar”. Usa las indicaciones que te dio tu profesional de salud.');
    }

    if (matches(/\b(agreg\w*|anadir|añadir|registr\w*|nuevo|nueva|crear)\b/) && matches(/\b(medicamento|medicamentos)\b/)) {
      return reply('Para añadir un medicamento a un tratamiento en curso, abre Tratamientos, cambia a la pestaña “Medicamentos” y pulsa “Agregar medicamento”. Selecciona el tratamiento y completa nombre, frecuencia y duración (mínimo 1 día); concentración, dosis e instrucciones son datos adicionales y la hora se asigna automáticamente. Registra solo lo indicado por tu profesional de salud.');
    }

    if (matches(/\b(record\w*|recuerd\w*|aviso|notificacion\w*)\b/)) {
      return reply('Tratamientos muestra los horarios programados y permite marcar las tomas realizadas; el Dashboard muestra la próxima toma. No encontré en la aplicación un envío implementado de notificaciones automáticas, así que no puedo garantizar que llegue un aviso al teléfono o correo.');
    }

    if (matches(/\b(edit\w*|modific\w*)\b/) && matches(/\b(tratamiento|tratamientos)\b/)) {
      return reply('En Tratamientos, abre la tarjeta de un tratamiento activo y pulsa “Editar”. Puedes cambiar su nombre, diagnóstico o notas; para modificar medicamentos usa las acciones de cada medicamento.');
    }

    if (matches(/\b(error|problema|no puedo|no me deja|falla|no aparece|no carga|no funciona)\b/)) {
      return reply('Confirma que estés en Tratamientos y que los filtros no estén ocultando el registro. Si el problema continúa, abre Soporte > “Nueva incidencia”, describe los pasos y el mensaje de error, y selecciona “Tratamientos y medicamentos”.');
    }

    return reply('En Tratamientos puedes consultar tratamientos y medicamentos, revisar horarios e historial, marcar tomas dentro del margen permitido y registrar ajustes indicados por tu profesional de salud. La app no prescribe ni recomienda dosis.');
  }

  if (asksAboutAppointment) {
    if (matches(/\b(elimin\w*|borr\w*|quit\w*)\b/)) {
      return reply('En la pantalla Citas no hay una opción para eliminar definitivamente. Si está pendiente, pulsa “Cancelar” y confirma la acción; quedará con estado Cancelada para conservar el seguimiento.');
    }

    if (matches(/\b(cancel\w*|anul\w*)\b/)) {
      return reply('En Citas, busca la cita pendiente, pulsa “Cancelar” y confirma “Sí, cancelar”. La cita quedará en estado Cancelada; no se elimina del historial.');
    }

    if (matches(/\b(reagend\w*|reprogram\w*|mover|cambiar fecha|cambiar hora)\b/)) {
      return reply('En Citas, pulsa “Reagendar” en la cita pendiente, elige la nueva fecha y hora y guarda. No se permiten fechas pasadas.');
    }

    if (matches(/\b(edit\w*|modific\w*)\b/)) {
      return reply('En Citas, pulsa “Editar” en una cita pendiente con fecha de hoy o futura. Puedes cambiar médico, especialidad, tipo, lugar y notas; para cambiar fecha u hora usa “Reagendar”.');
    }

    if (matches(/\b(record\w*|recuerd\w*|aviso|notificacion\w*)\b/)) {
      return reply('En el detalle de una cita se muestra si el campo “Recordatorio” está activado. No encontré en la aplicación un servicio que envíe la notificación, así que revisa la fecha en Citas o Dashboard y no dependas de un aviso automático.');
    }

    if (matches(/\b(registr\w*|agend\w*|program\w*|cre\w*|nuev\w*)\b/)) {
      return reply('Abre “Citas” y pulsa “Nueva cita”. Completa Médico, Especialidad, Fecha, Hora y Tipo (Presencial o Virtual); Lugar y Notas son opcionales. Pulsa “Guardar”. Esta función registra una cita que ya acordaste con el médico; no reserva una cita ni confirma disponibilidad.');
    }

    if (matches(/\b(error|problema|no puedo|no me deja|falla|no aparece|no encuentro|no carga|no funciona)\b/)) {
      return reply('En Citas, revisa que el filtro esté en “Todas” y busca por médico, especialidad o lugar. Si no se resuelve, registra una incidencia en Soporte > “Nueva incidencia” y selecciona “Citas”.');
    }

    return reply('En “Citas” puedes consultar tus citas en Lista, Mes, Semana o Día. Las citas pendientes permiten Editar, Reagendar o Cancelar. Esta sección registra citas que ya acordaste con el médico.');
  }

  if (asksAboutStudy) {
    if (matches(/\b(elimin\w*|borr\w*)\b/)) {
      return reply('En Estudios no hay una opción para borrar definitivamente. Si el estudio está pendiente, puedes pulsar “Cancelar”; seguirá visible con estado Cancelado.');
    }

    if (matches(/\b(subir|cargar|adjuntar|descarg\w*)\b/) && matches(/\b(resultad\w*|archivo|pdf|informe)\b/)) {
      return reply('Los resultados como archivo se administran en Documentos, no dentro de la cita del estudio. Abre Documentos para subir una imagen o PDF en la categoría “Estudio”, o pulsa la descarga junto al archivo existente.');
    }

    if (matches(/\b(cancel\w*|anul\w*)\b/)) {
      return reply('En Estudios, busca el estudio pendiente, pulsa “Cancelar” y confirma. Su estado cambiará a Cancelado.');
    }

    if (matches(/\b(reagend\w*|reprogram\w*|mover|cambiar fecha|cambiar hora)\b/)) {
      return reply('En Estudios, pulsa “Reagendar” en el estudio pendiente, elige la nueva fecha y hora y guarda los cambios.');
    }

    if (matches(/\b(resultad\w*|informe|reporte de laboratorio)\b/)) {
      return reply('La sección Estudios registra el tipo, fecha, hora, lugar y estado del estudio; no muestra resultados clínicos. Si tienes el resultado como archivo, súbelo en Documentos con categoría “Estudio”.');
    }

    if (matches(/\b(edit\w*|modific\w*)\b/)) {
      return reply('En Estudios, pulsa “Editar” en el estudio pendiente para cambiar título, tipo, lugar o notas. Para cambiar fecha u hora usa “Reagendar”; no se pueden editar estudios con fecha pasada.');
    }

    if (matches(/\b(registr\w*|program\w*|agend\w*|cre\w*|nuev\w*)\b/)) {
      return reply('Abre Estudios > “Nuevo estudio”. Completa Título, Tipo, Fecha y Hora; Lugar y Notas son opcionales. Puedes elegir Laboratorio, Radiología, Tomografía, Resonancia, Ultrasonido, Electrocardiograma, Endoscopia, Biopsia u Otro. Pulsa “Guardar”.');
    }

    if (matches(/\b(error|problema|no puedo|no me deja|falla|no aparece|no encuentro|no carga|no funciona)\b/)) {
      return reply('En Estudios, revisa que el filtro esté en “Todos” y busca por título, tipo o lugar. Si continúa el problema, registra una incidencia en Soporte > “Nueva incidencia” y selecciona “Estudios y resultados”.');
    }

    return reply('En Estudios puedes buscar y filtrar estudios pendientes, completados o cancelados, y verlos en Lista, Mes, Semana o Día. La pantalla organiza citas de estudios; los archivos de resultados se guardan en Documentos.');
  }

  if (matches(/\b(recuperar|olvide|olvidado|no recuerdo)\b/) && matches(/\b(contrasena|clave|password|cuenta)\b/)) {
    return reply('En la pantalla de acceso pulsa “Olvidé mi contraseña”. Ingresa tu correo, escribe el código de 6 dígitos que recibas y crea una contraseña nueva (mínimo 6 caracteres). Revisa Spam; nunca compartas el código por el chat. Si aparece un error o no llega, registra una incidencia en Soporte.');
  }

  if (matches(/\b(codigo|clave de verificacion)\b/) && matches(/\b(no lleg\w*|no recib\w*|reenviar|recuperacion|contrasena|correo)\b/)) {
    return reply('Para recuperar la contraseña, revisa Spam y solicita el código otra vez cuando termine el contador de reenvío. El código tiene 6 dígitos y no debes compartirlo. Si el envío falla o el contador termina y no llega, registra una incidencia en Soporte.');
  }

  if (matches(/\b(cambi\w*|actualizar|modific\w*)\b/) && matches(/\b(contrasena|clave|password)\b/)) {
    return reply('Ve a Perfil > Seguridad > “Cambiar contraseña”. Ingresa la contraseña actual, escribe la nueva (mínimo 6 caracteres), confírmala y guarda.');
  }

  if (matches(/\b(correo|email)\b/) && matches(/\b(cambi\w*|actualizar|modific\w*)\b/)) {
    return reply('El correo aparece como campo no editable en Perfil. Si necesitas corregirlo, contacta a soporte desde Mesa de ayuda; no crees otra cuenta antes de confirmar cómo conservar tus datos.');
  }

  if (matches(/\b(eliminar|borrar|cerrar)\b/) && matches(/\b(cuenta|usuario)\b/)) {
    return reply('La pantalla Perfil no ofrece una opción para eliminar la cuenta. Registra una incidencia en Soporte para solicitar orientación; no puedo confirmar desde aquí una eliminación de datos.');
  }

  if (matches(/\b(perfil|nombre|apellido|telefono)\b/) && matches(/\b(cambi\w*|actualizar|editar|modific\w*)\b/)) {
    return reply('Abre Perfil > “Editar”. Puedes actualizar nombre, apellido y teléfono; el correo no se puede modificar desde esa pantalla. Pulsa “Guardar cambios”.');
  }

  if (matches(/\b(perfil|correo|email|telefono)\b/)) {
    return reply('En Perfil puedes consultar tu información personal y acceder a Seguridad. El botón “Editar” permite actualizar nombre, apellido y teléfono; el correo no se puede modificar desde esa pantalla.');
  }

  if (matches(/\b(registro|registrarme|crear cuenta|crear usuario|darme de alta)\b/)) {
    return reply('En “Crear cuenta” completa nombre, apellido, correo y contraseña, confirma la contraseña y acepta los términos. El teléfono es opcional; la contraseña debe tener al menos 6 caracteres. Después del registro, la app inicia sesión y abre el Dashboard.');
  }

  if (matches(/\b(iniciar sesion|inicio de sesion|entrar|acceder|login)\b/)) {
    return reply('En la pantalla de acceso ingresa el correo y la contraseña de tu cuenta. Si olvidaste la contraseña, usa “Olvidé mi contraseña”; no compartas tu contraseña ni códigos de verificación por el chat.');
  }

  if (matches(/\b(admin|administrador|administracion)\b/)) {
    return reply('El menú de administrador incluye Inicio, Usuarios y Mesa de ayuda. Inicio muestra estadísticas de usuarios e incidencias; en Usuarios se pueden buscar, crear, editar, activar, suspender o eliminar cuentas; en Mesa de ayuda se revisan, responden y actualizan incidencias. Las cuentas administradoras no registran incidencias propias.');
  }

  if (asksAboutChat) {
    if (matches(/\b(error|problema|no puedo|no me deja|no funciona|no carga)\b/)) {
      return reply('Si el ChatBox no carga o no envía mensajes, verifica que tu sesión siga activa. Si continúa, registra una incidencia en Soporte > “Nueva incidencia” y selecciona “Soporte técnico”.');
    }

    return reply('El ChatBox permite enviar consultas desde el Dashboard. Las preguntas reconocidas reciben una respuesta automática; si no hay una respuesta configurada, el mensaje queda en la conversación para que soporte lo revise. Para seguimiento con estado, registra una incidencia en Soporte.');
  }

  if (matches(/\b(ticket|incidencia|reporte|seguimiento|soporte|problema|error)\b/)) {
    if (matches(/\b(estado|seguimiento|respuesta|responder|actualizar|consultar|revisar|ver|donde|mis reportes)\b/)) {
      return reply('En Soporte, selecciona un reporte para ver su descripción, estado y “Seguimiento”. Puedes agregar información desde el cuadro de respuesta. Los estados son Abierto, En proceso, Resuelto y Cerrado.');
    }

    return reply('Abre Soporte > “Nueva incidencia”. Escribe un asunto, elige una categoría (Soporte técnico, Cuenta y acceso, Citas, Estudios y resultados, Tratamientos y medicamentos, Documentos u Otro) y describe el problema con al menos 15 caracteres. Luego puedes seleccionar el reporte en “Mis reportes” para consultar el estado y agregar información.');
  }

  if (matches(/\b(dashboard|inicio|resumen)\b/)) {
    return reply('El Dashboard resume la próxima toma, próxima cita, tratamientos activos y tomas completadas hoy; también muestra próximas citas, estudios y documentos recientes. Usa los enlaces “Ver todos” para abrir cada sección.');
  }

  if (matches(/\b(ayuda|faq|preguntas frecuentes|contacto|correo de soporte)\b/)) {
    return reply('Puedes consultar /faq para preguntas frecuentes y /ayuda para recursos de contacto. También puedes iniciar sesión y abrir Soporte para usar el ChatBox o registrar una incidencia.');
  }

  if (matches(/\b(sel kalis|aplicacion|sistema|plataforma)\b/)) {
    return reply('Sel Kalis permite organizar tratamientos y tomas, registrar citas y estudios, guardar documentos médicos, consultar un Dashboard y contactar soporte. No sustituye a profesionales de salud. Dime qué sección o acción necesitas y te guío.');
  }

  return reply('No tengo una respuesta confiable para esa pregunta. Para que el equipo te ayude, abre Soporte > “Nueva incidencia”, selecciona la categoría “Soporte técnico” y describe qué intentabas hacer, qué ocurrió y cualquier mensaje de error. Podrás consultar el seguimiento en “Mis reportes”.');
}

function requesterName(user) {
  return [user.nombre, user.apellido].filter(Boolean).join(' ').trim() || user.email;
}

async function getConversationForUser(user) {
  const { data, error } = await supabase
    .from('support_conversations')
    .upsert({
      usuario_id: user.id,
      nombre: requesterName(user),
      email: user.email
    }, { onConflict: 'usuario_id' })
    .select('id')
    .single();

  if (error) throw error;
  return data;
}

async function findTicket(ticketId) {
  const { data, error } = await supabase
    .from('support_tickets')
    .select('*')
    .eq('id', ticketId)
    .single();

  if (error) throw error;
  return data;
}

async function canReadTicket(ticketId, user) {
  const ticket = await findTicket(ticketId);
  if (user.rol !== 'admin' && ticket.usuario_id !== user.id) return null;
  return ticket;
}

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'soporte-service' });
});

app.get('/notifications/config', authenticate, (req, res) => {
  res.json({
    success: true,
    data: {
      pushAvailable: pushConfigured,
      publicKey: pushConfigured ? pushPublicKey : ''
    }
  });
});

app.post('/notifications/test-push', authenticate, async (req, res) => {
  if (!pushConfigured) {
    return res.status(503).json({
      success: false,
      error: 'El servicio de notificaciones push aún no está configurado en Render.'
    });
  }

  try {
    const preferences = await getPreferences(req.user.id);
    if (!preferences.push_enabled) {
      return res.status(409).json({ success: false, error: 'Activa primero las notificaciones push para tu cuenta.' });
    }
    if (!preferences.soporte_enabled) {
      return res.status(409).json({ success: false, error: 'Activa la categoría de soporte para probar la notificación.' });
    }

    const sent = await sendPush(req.user.id, {
      tipo: 'soporte',
      event_key: `push-test:${req.user.id}:${Date.now()}`
    }, preferences);

    if (!sent) {
      return res.status(409).json({
        success: false,
        error: 'No hay una suscripción push activa. Desactiva y vuelve a activar las notificaciones en Perfil.'
      });
    }

    return res.json({ success: true, data: { sent } });
  } catch (error) {
    console.error('Error al enviar una notificación push de prueba:', error);
    if (isNotificationsSchemaMissing(error)) return notificationSchemaUnavailable(res);
    const message = error?.statusCode === 401 || error?.statusCode === 403
      ? 'La suscripción no coincide con las claves VAPID actuales. Desactiva y vuelve a activar las notificaciones en Perfil.'
      : 'El servidor no pudo entregar la notificación push de prueba. Revisa los logs de soporte-service en Render.';
    return res.status(502).json({ success: false, error: message });
  }
});

app.get('/notifications/preferences', authenticate, async (req, res) => {
  try {
    const data = await getPreferences(req.user.id);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error en GET /notifications/preferences:', error);
    if (isNotificationsSchemaMissing(error)) return notificationSchemaUnavailable(res);
    return res.status(500).json({ success: false, error: 'No se pudieron cargar las preferencias de notificación' });
  }
});

app.put('/notifications/preferences', authenticate, async (req, res) => {
  const allowedFields = ['medicamentos_enabled', 'citas_enabled', 'soporte_enabled'];
  const changes = {};
  for (const field of allowedFields) {
    if (req.body?.[field] !== undefined) {
      if (typeof req.body[field] !== 'boolean') {
        return res.status(400).json({ success: false, error: `La preferencia ${field} debe ser booleana` });
      }
      changes[field] = req.body[field];
    }
  }

  if (req.body?.timezone !== undefined) {
    if (typeof req.body.timezone !== 'string' || req.body.timezone.length > 100) {
      return res.status(400).json({ success: false, error: 'Zona horaria no válida' });
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: req.body.timezone });
      changes.timezone = req.body.timezone;
    } catch {
      return res.status(400).json({ success: false, error: 'Zona horaria no válida' });
    }
  }

  try {
    const current = await getPreferences(req.user.id);
    const { data, error } = await supabase
      .from('notification_preferences')
      .upsert({
        ...current,
        ...changes,
        updated_at: new Date().toISOString()
      }, { onConflict: 'usuario_id' })
      .select('*')
      .single();

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error en PUT /notifications/preferences:', error);
    if (isNotificationsSchemaMissing(error)) return notificationSchemaUnavailable(res);
    return res.status(500).json({ success: false, error: 'No se pudieron guardar las preferencias de notificación' });
  }
});

app.post('/notifications/subscriptions', authenticate, async (req, res) => {
  if (!pushConfigured) {
    return res.status(503).json({ success: false, error: 'Las notificaciones push aún no están configuradas en el servidor' });
  }

  const subscription = req.body?.subscription;
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;
  const timezone = req.body?.timezone || 'America/Mexico_City';

  if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
    return res.status(400).json({ success: false, error: 'La suscripción push no tiene un formato válido' });
  }
  try {
    if (new URL(endpoint).protocol !== 'https:') {
      return res.status(400).json({ success: false, error: 'El endpoint de push debe usar HTTPS' });
    }
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return res.status(400).json({ success: false, error: 'Endpoint o zona horaria no válidos' });
  }

  try {
    const current = await getPreferences(req.user.id);
    const { error: subscriptionError } = await supabase
      .from('notification_subscriptions')
      .upsert({
        usuario_id: req.user.id,
        endpoint,
        p256dh,
        auth,
        updated_at: new Date().toISOString()
      }, { onConflict: 'endpoint' });
    if (subscriptionError) throw subscriptionError;

    const { error: preferencesError } = await supabase
      .from('notification_preferences')
      .upsert({
        ...current,
        push_enabled: true,
        timezone,
        updated_at: new Date().toISOString()
      }, { onConflict: 'usuario_id' });
    if (preferencesError) throw preferencesError;

    return res.status(201).json({ success: true, data: { push_enabled: true } });
  } catch (error) {
    console.error('Error en POST /notifications/subscriptions:', error);
    return res.status(500).json({ success: false, error: 'No se pudo guardar la suscripción push' });
  }
});

app.delete('/notifications/subscriptions', authenticate, async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint !== undefined && typeof endpoint !== 'string') {
    return res.status(400).json({ success: false, error: 'Endpoint de push no válido' });
  }

  try {
    let query = supabase
      .from('notification_subscriptions')
      .delete()
      .eq('usuario_id', req.user.id);
    if (endpoint) query = query.eq('endpoint', endpoint);

    const { error: subscriptionError } = await query;
    if (subscriptionError) throw subscriptionError;

    const { error: preferencesError } = await supabase
      .from('notification_preferences')
      .upsert({
        ...defaultPreferences(req.user.id),
        ...(await getPreferences(req.user.id)),
        push_enabled: false,
        updated_at: new Date().toISOString()
      }, { onConflict: 'usuario_id' });
    if (preferencesError) throw preferencesError;

    return res.json({ success: true, data: { push_enabled: false } });
  } catch (error) {
    console.error('Error en DELETE /notifications/subscriptions:', error);
    return res.status(500).json({ success: false, error: 'No se pudo desactivar la suscripción push' });
  }
});

app.get('/notifications', authenticate, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  try {
    const { data, error } = await supabase
      .from('app_notifications')
      .select('*')
      .eq('usuario_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error en GET /notifications:', error);
    return res.status(500).json({ success: false, error: 'No se pudieron cargar las notificaciones' });
  }
});

app.patch('/notifications/read-all', authenticate, async (req, res) => {
  try {
    const { error } = await supabase
      .from('app_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('usuario_id', req.user.id)
      .is('read_at', null);
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error('Error en PATCH /notifications/read-all:', error);
    return res.status(500).json({ success: false, error: 'No se pudieron marcar como leídas' });
  }
});

app.patch('/notifications/:id/read', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('app_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('usuario_id', req.user.id)
      .select('*')
      .single();
    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error en PATCH /notifications/:id/read:', error);
    return res.status(500).json({ success: false, error: 'No se pudo marcar la notificación como leída' });
  }
});

app.post('/notifications/events/appointment', authenticate, async (req, res) => {
  const event = req.body;
  const appointment = event?.appointment;
  const eventType = event?.eventType;
  if (!['created', 'updated', 'status_changed'].includes(eventType)
    || !appointment?.id || !appointment?.fecha || !appointment?.hora) {
    return res.status(400).json({ success: false, error: 'Evento de cita no válido' });
  }

  const eventSuffix = event?.eventKey;
  if (typeof eventSuffix !== 'string' || eventSuffix.length < 1 || eventSuffix.length > 180) {
    return res.status(400).json({ success: false, error: 'Identificador de evento no válido' });
  }

  const title = eventType === 'created'
    ? 'Cita registrada'
    : eventType === 'status_changed'
      ? 'Estado de cita actualizado'
      : 'Cita actualizada';
  const mensaje = eventType === 'status_changed'
    ? `El estado de tu cita ${appointment.titulo || ''} cambió a ${appointment.estado || 'actualizado'}.`
    : `Tu cita ${appointment.titulo || ''} está programada para el ${appointment.fecha} a las ${appointment.hora.slice(0, 5)}.`;

  try {
    await notifyUser(req.user.id, {
      tipo: 'cita',
      titulo: title,
      mensaje,
      event_key: `appointment-event:${eventSuffix}`,
      datos: { url: '/citas', cita_id: appointment.id }
    });
    return res.status(202).json({ success: true });
  } catch (error) {
    console.error('Error en POST /notifications/events/appointment:', error);
    return res.status(500).json({ success: false, error: 'No se pudo registrar la notificación de cita' });
  }
});

app.get('/chat/mensajes', authenticate, async (req, res) => {
  try {
    const conversation = await getConversationForUser(req.user);
    const { data, error } = await supabase
      .from('support_chat_messages')
      .select('*')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error en GET /chat/mensajes:', error);
    return res.status(500).json({ success: false, error: 'No se pudieron cargar los mensajes' });
  }
});

app.post('/chat/mensajes', authenticate, async (req, res) => {
  const mensaje = readMessage(req.body?.mensaje);
  if (!mensaje || mensaje.length > 1000) {
    return res.status(400).json({ success: false, error: 'El mensaje debe tener entre 1 y 1000 caracteres' });
  }

  try {
    const conversation = await getConversationForUser(req.user);
    const automaticMessage = automaticReply(mensaje);
    const createdAt = new Date();
    const { data, error } = await supabase
      .from('support_chat_messages')
      .insert([
        {
          conversation_id: conversation.id,
          sender_id: req.user.id,
          sender_role: 'user',
          mensaje,
          created_at: createdAt.toISOString()
        },
        ...(automaticMessage ? [{
          conversation_id: conversation.id,
          sender_id: req.user.id,
          sender_role: 'admin',
          mensaje: automaticMessage,
          created_at: new Date(createdAt.getTime() + 1).toISOString()
        }] : [])
      ])
      .select('*');

    if (error) throw error;
    const orderedMessages = data.sort((first, second) =>
      first.created_at.localeCompare(second.created_at)
    );
    const { error: updateError } = await supabase
      .from('support_conversations')
      .update({ ultimo_mensaje: automaticMessage || mensaje, updated_at: new Date().toISOString() })
      .eq('id', conversation.id);
    if (updateError) throw updateError;

    return res.status(201).json({ success: true, data: orderedMessages });
  } catch (error) {
    console.error('Error en POST /chat/mensajes:', error);
    return res.status(500).json({ success: false, error: 'No se pudo enviar el mensaje' });
  }
});

app.get('/tickets', authenticate, async (req, res) => {
  try {
    let query = supabase.from('support_tickets').select('*');
    if (req.user.rol !== 'admin') query = query.eq('usuario_id', req.user.id);

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error en GET /tickets:', error);
    return res.status(500).json({ success: false, error: 'No se pudieron cargar los reportes' });
  }
});

app.post('/tickets', authenticate, async (req, res) => {
  if (req.user.rol === 'admin') {
    return res.status(403).json({ success: false, error: 'Los administradores no pueden registrar incidencias' });
  }

  const asunto = readMessage(req.body?.asunto);
  const descripcion = readMessage(req.body?.descripcion);
  const categoria = req.body?.categoria;

  if (!asunto || asunto.length > 120 || descripcion.length < 15 || descripcion.length > 2000) {
    return res.status(400).json({ success: false, error: 'Revisa el asunto y describe el problema (15 a 2000 caracteres)' });
  }
  if (!ticketCategories.includes(categoria)) {
    return res.status(400).json({ success: false, error: 'Categoría de incidencia no válida' });
  }

  try {
    const { data, error } = await supabase
      .from('support_tickets')
      .insert({
        usuario_id: req.user.id,
        nombre_solicitante: requesterName(req.user),
        email_solicitante: req.user.email,
        asunto,
        categoria,
        descripcion
      })
      .select('*')
      .single();

    if (error) throw error;
    void notifyAdmins({
      tipo: 'soporte',
      titulo: 'Nueva incidencia',
      mensaje: `Se registró una incidencia: ${data.asunto}.`,
      event_key: `ticket-created:${data.id}`,
      datos: { url: '/soporte', ticket_id: data.id }
    }).catch(notificationError => {
      console.error('No se pudo notificar la nueva incidencia:', notificationError);
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('Error en POST /tickets:', error);
    return res.status(500).json({ success: false, error: 'No se pudo registrar la incidencia' });
  }
});

app.patch('/tickets/:id', authenticate, requireAdmin, async (req, res) => {
  const estado = req.body?.estado;
  if (!ticketStatuses.includes(estado)) {
    return res.status(400).json({ success: false, error: 'Estado de incidencia no válido' });
  }

  try {
    const previousTicket = await findTicket(req.params.id);
    const { data, error } = await supabase
      .from('support_tickets')
      .update({ estado, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error) throw error;
    if (previousTicket.estado !== data.estado) {
      void notifyUser(data.usuario_id, {
        tipo: 'soporte',
        titulo: 'Estado de incidencia actualizado',
        mensaje: `Tu incidencia "${data.asunto}" cambió a ${data.estado.replace('_', ' ')}.`,
        event_key: `ticket-status:${data.id}:${data.estado}:${data.updated_at}`,
        datos: { url: '/soporte', ticket_id: data.id, estado: data.estado }
      }).catch(notificationError => {
        console.error('No se pudo notificar el cambio de estado:', notificationError);
      });
    }
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error en PATCH /tickets/:id:', error);
    return res.status(500).json({ success: false, error: 'No se pudo actualizar la incidencia' });
  }
});

app.get('/tickets/:id/respuestas', authenticate, async (req, res) => {
  try {
    const ticket = await canReadTicket(req.params.id, req.user);
    if (!ticket) {
      return res.status(403).json({ success: false, error: 'No tienes permiso para consultar esta incidencia' });
    }

    const { data, error } = await supabase
      .from('support_ticket_replies')
      .select('*')
      .eq('ticket_id', ticket.id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error en GET /tickets/:id/respuestas:', error);
    return res.status(500).json({ success: false, error: 'No se pudieron cargar las respuestas' });
  }
});

app.post('/tickets/:id/respuestas', authenticate, async (req, res) => {
  const mensaje = readMessage(req.body?.mensaje);
  if (!mensaje || mensaje.length > 1000) {
    return res.status(400).json({ success: false, error: 'La respuesta debe tener entre 1 y 1000 caracteres' });
  }

  try {
    const ticket = await canReadTicket(req.params.id, req.user);
    if (!ticket) {
      return res.status(403).json({ success: false, error: 'No tienes permiso para responder esta incidencia' });
    }

    const { data, error } = await supabase
      .from('support_ticket_replies')
      .insert({
        ticket_id: ticket.id,
        sender_id: req.user.id,
        sender_role: req.user.rol === 'admin' ? 'admin' : 'user',
        mensaje
      })
      .select('*')
      .single();

    if (error) throw error;
    if (req.user.rol === 'admin') {
      void notifyUser(ticket.usuario_id, {
        tipo: 'soporte',
        titulo: 'Nueva respuesta de soporte',
        mensaje: `Soporte respondió a tu incidencia "${ticket.asunto}".`,
        event_key: `ticket-reply:${data.id}:user:${ticket.usuario_id}`,
        datos: { url: '/soporte', ticket_id: ticket.id }
      }).catch(notificationError => {
        console.error('No se pudo notificar la respuesta de soporte:', notificationError);
      });
    } else {
      void notifyAdmins({
        tipo: 'soporte',
        titulo: 'Nuevo mensaje en incidencia',
        mensaje: `El usuario respondió a la incidencia "${ticket.asunto}".`,
        event_key: `ticket-reply:${data.id}`,
        datos: { url: '/soporte', ticket_id: ticket.id }
      }).catch(notificationError => {
        console.error('No se pudo notificar el mensaje del usuario:', notificationError);
      });
    }
    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('Error en POST /tickets/:id/respuestas:', error);
    return res.status(500).json({ success: false, error: 'No se pudo enviar la respuesta' });
  }
});

app.listen(PORT, () => {
  console.log(`Soporte Service running on port ${PORT}`);
  console.log(`CORS permitido para: ${frontendUrl}`);
  startReminderScheduler();
});
