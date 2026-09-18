-- Канон портфеля на 2026-09-18. Не лента чата, а записи.
DELETE FROM links;
DELETE FROM origins;
DELETE FROM packets;
DELETE FROM events;
DELETE FROM objects;

INSERT INTO objects(id,cluster,layer,type,title,status,body,created_at,updated_at,owner) VALUES
('S001','A',1,'session','ChatGPT share Enbek','closed','https://chatgpt.com/share/6aad25ca-efbc-83ed-aa6f-984372bd4525','2026-09-17T17:50:00','2026-09-18','human'),
('F001','A',1,'fact','13 дней до статуса, пилот 01.10.2026','canon','оргреформа, не сама модель ИИ','2026-09-18','2026-09-18','registrar'),
('F002','A',1,'fact','выплата max 3 мес с 01.01.2027','canon','центральная линия Минтруда','2026-09-18','2026-09-18','registrar'),
('F003','A',1,'fact','потолок выплаты 45% от 7 МЗП','canon',NULL,'2026-09-18','2026-09-18','registrar'),
('F004','A',1,'fact','840,6 тыс вакансий / 1,022 млн резюме в 2026','canon',NULL,'2026-09-18','2026-09-18','registrar'),
('F005','A',1,'fact','пилот Павлодар, масштаб на страну 2026','canon',NULL,'2026-09-18','2026-09-18','registrar'),
('F006','A',1,'fact','заявленные функции ИИ Enbek','canon','профиль, резюме, вакансии, gap, Skills Enbek','2026-09-18','2026-09-18','registrar'),
('Q001','A',1,'question','13 дней — сервис или отсрочка статуса','open',NULL,'2026-09-18','2026-09-18','human'),
('Q002','A',1,'question','какая дата выплат официально при конфликте источников','open',NULL,'2026-09-18','2026-09-18','human'),
('Q003','A',1,'question','есть ли у Enbek живой skill-graph с id','open',NULL,'2026-09-18','2026-09-18','human'),
('D001','A',1,'decision','датой выплаты считать 01.01.2027','canon','пока нет нового письма Минтруда','2026-09-18','2026-09-18','human'),
('D002','A',1,'decision','ИИ не заменяет карьерные центры','canon','гибрид','2026-09-18','2026-09-18','human'),
('D003','A',1,'decision','foresight-спека не принадлежит проекту A','canon',NULL,'2026-09-18','2026-09-18','human'),
('A001','A',1,'artifact','контур observe-model-recommend-act-measure-learn','draft',NULL,'2026-09-18','2026-09-18','registrar'),
('A002','A',1,'artifact','поля цифрового профиля','draft',NULL,'2026-09-18','2026-09-18','registrar'),
('P001','A',1,'packet','пакет в технопарк: контур и граф, без выплат','closed','см. packets','2026-09-18','2026-09-18','courier'),
('S002','B',1,'session','какие узлы графа первыми','closed',NULL,'2026-09-18','2026-09-18','human'),
('S003','D',2,'session','отбор объектов из спеки 12633+','closed',NULL,'2026-09-18','2026-09-18','human'),
('S004','D',2,'session','живая регистрация слоя 2','closed',NULL,'2026-09-18','2026-09-18','human'),
('Q101','B',1,'question','какие узлы заводить первыми','closed',NULL,'2026-09-18','2026-09-18','human'),
('Q102','D',2,'question','что брать из спеки 12633+','closed',NULL,'2026-09-18','2026-09-18','human'),
('D101','B',1,'decision','первая волна: person skill task artifact decision','canon',NULL,'2026-09-18','2026-09-18','human'),
('D102','B',1,'decision','сдача = task + accepted artifact','canon',NULL,'2026-09-18','2026-09-18','human'),
('D103','D',2,'decision','вторая волна: observation signal signpost','canon',NULL,'2026-09-18','2026-09-18','human'),
('T101','B',1,'task','написать SESSION S002','closed',NULL,'2026-09-18','2026-09-18','human'),
('T201','B',1,'task','не копировать Enbek','open','правило из SP001','2026-09-18','2026-09-18','human'),
('C-OS','C',1,'question','выжимка Innovation OS PAST/PRESENT/PLANNED или вычесть кластер','open','в чате только ярлыки','2026-09-18','2026-09-18','human'),
('O001','D',2,'observation','Inbusiness 17.09.2026','raw','https://inbusiness.kz/ru/news/rabotu-kazahstancam-budet-podbirat-ii-kak-izmenitsya-sistema-zanyatosti','2026-09-18','2026-09-18','registrar'),
('O002','D',2,'observation','TimesCA 11.08.2026 Павлодар 39000/962','raw','причинность трудоустройств не доказана','2026-09-18','2026-09-18','registrar'),
('SIG001','D',2,'signal','госконтур matching уже в пилоте','candidate','O001+O002; relevant_to D102','2026-09-18','2026-09-18','registrar'),
('SP001','D',2,'signpost','третья observation про граф навыков с id','dormant','пока не сработал','2026-09-18','2026-09-18','registrar');

INSERT INTO links(from_id,to_id,rel,note) VALUES
('D001','F002','cites','дата из факта'),
('F002','Q002','contradicts','региональные даты'),
('D002','F006','refines','заявка ИИ не равна замене центров'),
('D003','P001','derived_from','отделение хвоста'),
('Q001','F001','refines',NULL),
('D101','Q101','replaces','закрыл вопрос'),
('D102','P001','cites','контур сдачи из пакета'),
('D103','Q102','replaces',NULL),
('O001','SIG001','feeds',NULL),
('O002','SIG001','feeds',NULL),
('SIG001','D102','relevant_to','контур проверки факта'),
('SIG001','SP001','raises',NULL),
('SP001','T201','triggers','запрет копии Enbek'),
('A001','P001','derived_from',NULL),
('T101','S002','derived_from',NULL);

INSERT INTO origins(object_id,session_id,span) VALUES
('F001','S001','статья + разбор'),
('F002','S001','статья + разбор'),
('F003','S001','статья'),
('F004','S001','статья'),
('F005','S001','статья'),
('F006','S001','статья'),
('Q001','S001',NULL),
('Q002','S001',NULL),
('Q003','S001',NULL),
('D001','S001',NULL),
('D002','S001',NULL),
('D003','S001',NULL),
('D101','S002',NULL),
('D102','S002',NULL),
('D103','S003',NULL),
('O001','S004',NULL),
('O002','S004',NULL),
('SIG001','S004',NULL),
('SP001','S004',NULL);

INSERT INTO packets(id,from_session,to_session,subject,body,created_at,read_at) VALUES
('P001','S001','S002','что перенять из контура Enbek',
'Учти: гибрид ИИ+человек; контур observe-learn; граф урезать.
Не повторяй: выплаты, 13 дней.
Проверь: аналог фактической сдачи.',
'2026-09-18','2026-09-18');

INSERT INTO events(ts,actor,action,object_id,detail) VALUES
('2026-09-18T14:00:00','agent:registrar','seed',NULL,'первичная загрузка канона из плоскости');
